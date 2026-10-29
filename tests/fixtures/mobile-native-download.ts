// Run by mobile-native-download.test.ts in an isolated Bun subprocess.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import type { NativeDownloadStatus } from "../../web/src/mobile-download-manager.js";

type Progress = { type: string; url: string; bytes: number; lengthComputable: boolean; contentLength: number };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.ok(predicate(), "native fixture did not reach the expected state");
}

const scenario = process.argv[2];
const android = scenario?.startsWith("android");
const url = "https://bridge.fixture/api/files/report/download";
const token = "fixture-private-token";
const userAgent = `Mozilla/5.0 (${android ? "Linux; Android 14" : "iPhone; CPU iPhone OS 18_6 like Mac OS X"}) BridgeApp/0.5.0 (${android ? "Android" : "iOS"})`;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent } });
const listeners = new Set<(event: Progress) => void>();
let removedListeners = 0;
const transfers: Array<{ options: Record<string, unknown>; pending: ReturnType<typeof deferred<void>> }> = [];
const shares: Array<{ options: { files: string[] }; pending: ReturnType<typeof deferred<{ activityType: string }>> }> = [];
const enqueues: Array<{ options: Record<string, unknown>; pending: ReturnType<typeof deferred<{ id: number; fileName: string }>> }> = [];
const queries: Array<{ ids: number[]; pending: ReturnType<typeof deferred<{ downloads: NativeDownloadStatus[] }>> }> = [];
const removedDirectories: string[] = [];
const openedDownloads: number[] = [];
const cancelledDownloads: number[] = [];
const cacheChunks: Uint8Array[] = [];
const savedFiles: Array<Record<string, unknown>> = [];
const copiedImages: Array<Record<string, unknown>> = [];
const verifications: Array<Record<string, unknown>> = [];
const installations: Array<Record<string, unknown>> = [];
const apkSaves: Array<Record<string, unknown>> = [];
const clipboardWrites: Array<Record<string, unknown>> = [];
const nativeScans: Array<Record<string, unknown>> = [];
const appListeners = new Map<string, (event: any) => void>();
let notificationAction: ((event: any) => void) | undefined;
let shareReceived: ((event: { id?: string; error?: string }) => void) | undefined;
let nativePermission = "granted";
let permissionPrompts = 0;
const notices: Array<Record<string, any>> = [];
const incomingShare = { id: "00000000-0000-0000-0000-000000000001", text: "shared text", createdAt: 1,
  files: [{ id: "00000000-0000-0000-0000-000000000002", name: "test.png", type: "image/png", size: 3 }] };
const timers = new Map<number, () => void>();
let timerSequence = 0;
const windowEvents = new EventTarget();
const localRows = new Map<string, string>();
const sessionRows = new Map<string, string>();
Object.assign(windowEvents, { localStorage: { getItem: (key: string) => localRows.get(key) ?? null, setItem: (key: string, value: string) => { localRows.set(key, value); } },
  sessionStorage: { getItem: (key: string) => sessionRows.get(key) ?? null, setItem: (key: string, value: string) => { sessionRows.set(key, value); } } });
const documentEvents = Object.assign(new EventTarget(), { visibilityState: "visible" });
Object.defineProperty(documentEvents, "hidden", { get: () => documentEvents.visibilityState === "hidden" });
Object.defineProperty(globalThis, "window", { configurable: true, value: windowEvents });
Object.defineProperty(globalThis, "document", { configurable: true, value: documentEvents });
// Keep Android polling deterministic and do not leave real background timers alive.
Object.defineProperty(globalThis, "setTimeout", { value: (callback: () => void) => {
  const id = ++timerSequence;
  timers.set(id, callback);
  return id;
} });
Object.defineProperty(globalThis, "clearTimeout", { value: (id: number) => { timers.delete(id); } });

mock.module("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => android ? "android" : "ios", convertFileSrc: (uri: string) => "https://native.fixture/" + encodeURIComponent(uri) },
  registerPlugin: (name: string) => name === "BridgeShareInbox" ? {
    addListener: async (_event: string, callback: typeof shareReceived) => { shareReceived = callback; return { remove: async () => {} }; },
    listShares: async () => ({ shares: [incomingShare] }),
    getFile: async () => ({ uri: scenario === "android-share-invalid-uri" ? "https://evil.fixture/private" : "file:///fixture-inbox/test" }),
  } : name === "BridgeUpdater" ? {
    saveFile: async (options: Record<string, unknown>) => {
      savedFiles.push(options);
      if (scenario === "android-export-failure") throw new Error("fixture storage full");
      return { fileName: options.fileName as string, size: cacheChunks.reduce((size, chunk) => size + chunk.length, 0) };
    },
    copyImage: async (options: Record<string, unknown>) => { copiedImages.push(options); },
    verifyApk: async (options: Record<string, unknown>) => {
      verifications.push(options);
      if (scenario === "android-apk-invalid") throw new Error("更新包摘要不符");
    },
    install: async (options: Record<string, unknown>) => {
      installations.push(options);
      if (scenario === "android-apk-cancel") throw new Error("请允许 Bridge 安装未知来源应用后重试。");
    },
    saveApk: async (options: Record<string, unknown>) => { apkSaves.push(options); return { fileName: "verified.apk" }; },
    cancelDownload: async ({ id }: { id: number }) => { cancelledDownloads.push(id); return { cancelled: true }; },
    openDownloadedFile: async ({ id }: { id: number }) => { openedDownloads.push(id); },
    download: (options: Record<string, unknown>) => {
      const pending = deferred<{ id: number; fileName: string }>();
      enqueues.push({ options, pending });
      return pending.promise;
    },
    getDownloads: ({ ids }: { ids: number[] }) => {
      const pending = deferred<{ downloads: NativeDownloadStatus[] }>();
      queries.push({ ids, pending });
      return pending.promise;
    },
  } : {},
}));
mock.module("@capacitor/app", () => ({ App: {
  addListener: async (event: string, callback: (event: any) => void) => { appListeners.set(event, callback); return { remove: async () => {} }; },
  getLaunchUrl: async () => scenario === "android-open-cold" ? { url: "bridgecodex://open?server=https%3A%2F%2Fmac.fixture&path=%2Fmobile-inbox" } : undefined,
} }));
mock.module("@capacitor/local-notifications", () => ({ LocalNotifications: {
  addListener: async (_event: string, callback: typeof notificationAction) => { notificationAction = callback; return { remove: async () => {} }; },
  checkPermissions: async () => ({ display: nativePermission }),
  requestPermissions: async () => { permissionPrompts++; return { display: nativePermission }; },
  createChannel: async () => {},
  schedule: async (options: Record<string, any>) => { notices.push(options); },
} }));
mock.module("@capacitor/browser", () => ({ Browser: {} }));
mock.module("@capacitor/clipboard", () => ({ Clipboard: { write: async (options: Record<string, unknown>) => { clipboardWrites.push(options); } } }));
mock.module("@capacitor/barcode-scanner", () => ({ CapacitorBarcodeScanner: { scanBarcode: async (options: Record<string, unknown>) => {
  nativeScans.push(options);
  if (scenario === "android-scan-cancel") throw new Error("scan cancelled");
  if (scenario === "android-scan-failure") throw new Error("camera permission denied");
  return { ScanResult: " bridgecodex://connect?fixture=pairing " };
} } }));
mock.module("@capacitor/filesystem", () => ({
  Directory: { Cache: "CACHE" },
  Filesystem: {
    readdir: async () => ({ files: [] }),
    mkdir: async () => {},
    writeFile: async ({ path, data }: { path: string; data: string }) => {
      cacheChunks.push(Buffer.from(data, "base64")); return { uri: "file:///fixture-cache/" + path };
    },
    appendFile: async ({ data }: { data: string }) => { cacheChunks.push(Buffer.from(data, "base64")); },
    getUri: async ({ path }: { path: string }) => ({ uri: "file:///fixture-cache/" + path }),
    stat: async () => ({ size: 100 }),
    rmdir: async ({ path }: { path: string }) => { removedDirectories.push(path); },
  },
}));
mock.module("@capacitor/file-transfer", () => ({ FileTransfer: {
  addListener: async (eventName: string, callback: (event: Progress) => void) => {
    assert.equal(eventName, "progress");
    listeners.add(callback);
    return { remove: async () => { listeners.delete(callback); removedListeners += 1; } };
  },
  downloadFile: (options: Record<string, unknown>) => {
    const pending = deferred<void>();
    transfers.push({ options, pending });
    return pending.promise;
  },
} }));
mock.module("@capacitor/share", () => ({ Share: {
  share: (options: { files: string[] }) => {
    const pending = deferred<{ activityType: string }>();
    shares.push({ options, pending });
    return pending.promise;
  },
} }));

// Import the actual runtime and state store after installing process-local native mocks.
const native = await import("../../web/src/mobile-native.js");
const { getMobileDownloads, hasAndroidMobileDownloads } = await import("../../web/src/mobile-download-manager.js");
const { MOBILE_RESUME_EVENT } = await import("../../web/src/mobile-runtime.js");
const emit = (patch: Partial<Progress> = {}) => {
  const event = { type: "download", url, bytes: 11, lengthComputable: false, contentLength: 999, ...patch };
  for (const listener of listeners) listener(event);
};

if (scenario === "android-open-cold" || scenario === "android-open-warm") {
  await native.installNativeLifecycle();
  const { getMobileOpens } = await import("../../web/src/mobile-handoff.js");
  const url = "bridgecodex://open?server=https%3A%2F%2Fmac.fixture&path=%2Fmobile-inbox";
  appListeners.get("appUrlOpen")!({ url });
  appListeners.get("appUrlOpen")!({ url });
  assert.equal(getMobileOpens().length, 1);
  assert.equal(getMobileOpens()[0]?.kind, "route");
  process.exit(0);
}
if (scenario === "android-local-notice") {
  await native.installNativeLifecycle();
  const options = { id: 100, title: "new action", category: "action", server: "https://mac.fixture", scope: "fixture-device", route: "/tasks/desk/t1" };
  nativePermission = "denied";
  assert.equal(await native.showNativeNotification(options), false); assert.equal(notices.length, 0); assert.equal(permissionPrompts, 0);
  nativePermission = "granted";
  assert.equal(await native.showNativeNotification(options), true);
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0]?.notifications[0].extra, { server: options.server, scope: options.scope, route: options.route });
  notificationAction!({ notification: notices[0]!.notifications[0] });
  assert.equal((await import("../../web/src/mobile-handoff.js")).getMobileOpens()[0]?.server, options.server);
  assert.equal(permissionPrompts, 0);
  process.exit(0);
}
if (scenario === "android-share-import" || scenario === "android-share-invalid-uri") {
  let requests = 0;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (_url: string, init?: RequestInit) => {
    requests++; assert.equal(init, undefined); return new Response(new Uint8Array([1, 2, 3]));
  } });
  await native.installNativeLifecycle();
  const shares = await native.listIncomingShares(); assert.deepEqual(shares, [incomingShare]);
  if (scenario === "android-share-invalid-uri") {
    await assert.rejects(native.incomingShareFiles(incomingShare), /地址无效/); assert.equal(requests, 0);
  } else {
    const files = await native.incomingShareFiles(incomingShare);
    assert.equal(files[0]?.name, "test.png"); assert.equal(files[0]?.type, "image/png"); assert.equal(files[0]?.size, 3);
    shareReceived!({ id: incomingShare.id });
    assert.equal((await import("../../web/src/mobile-handoff.js")).getMobileOpens().length, 0, "a share does not navigate away from an editor or execute anything");
  }
  process.exit(0);
}

if (scenario === "android-restored") {
  await native.installNativeLifecycle();
  const { restoreMobileDownloads } = await import("../../web/src/mobile-download-manager.js");
  const storage = { getItem: () => JSON.stringify({ version: 1, tasks: [{ id: "restored", fileName: "old.pdf", destination: "downloads",
    state: "downloading", downloadedBytes: 50, totalBytes: 100, nativeId: 801, updatedAt: Date.now() }] }), setItem() {}, removeItem() {} };
  restoreMobileDownloads(storage, "fixture-device");
  assert.deepEqual(queries[0]?.ids, [801]);
  queries[0]!.pending.resolve({ downloads: [{ id: 801, fileName: "old.pdf", state: "done", downloadedBytes: 100, totalBytes: 100 }] });
  await until(() => getMobileDownloads()[0]?.state === "done");
  await native.openDownloadedFile("restored");
  assert.deepEqual(openedDownloads, [801]);
  process.exit(0);
}
if (scenario === "android-cancel") {
  const pending = native.downloadBridgeFile(url, "report.pdf", token);
  enqueues[0]!.pending.resolve({ id: 701, fileName: "report.pdf" }); await pending;
  const id = getMobileDownloads()[0]!.id;
  await native.cancelMobileDownload(id);
  assert.deepEqual(cancelledDownloads, [701]);
  assert.equal(getMobileDownloads()[0]?.state, "cancelled");
  queries[0]!.pending.resolve({ downloads: [{ id: 701, fileName: "report.pdf", state: "done", downloadedBytes: 100, totalBytes: 100 }] });
  await until(() => !hasAndroidMobileDownloads());
  assert.equal(getMobileDownloads()[0]?.state, "cancelled");
  await assert.rejects(native.openDownloadedFile(id), /系统下载/);
  assert.deepEqual(openedDownloads, []);
  process.exit(0);
}
if (scenario === "android-export-large" || scenario === "ios-export-large" || scenario === "android-export-failure") {
  const bytes = new Uint8Array(9 * 1024 * 1024 + 7).map((_, index) => index % 251);
  const blob = new Blob([bytes], { type: "text/plain" });
  Object.defineProperty(blob, "arrayBuffer", { value: () => { throw new Error("must not read the entire Blob"); } });
  const pending = native.shareBlob(blob, "large.log");
  if (scenario === "ios-export-large") {
    await until(() => shares.length > 0);
    shares[0]!.pending.resolve({ activityType: "fixture-save" });
  }
  if (scenario === "android-export-failure") {
    await assert.rejects(pending, /storage full/);
    assert.equal(getMobileDownloads()[0]?.state, "error");
  } else {
    await pending;
    assert.equal(getMobileDownloads()[0]?.state, "done");
    assert.equal(getMobileDownloads()[0]?.downloadedBytes, bytes.length);
  }
  assert.ok(cacheChunks.length > 1);
  assert.ok(cacheChunks.every((chunk) => chunk.length <= 512 * 1024));
  assert.deepEqual(Buffer.concat(cacheChunks), Buffer.from(bytes));
  if (android) {
    assert.ok(String(savedFiles[0]?.uri).startsWith("file:///fixture-cache/bridge-downloads/"));
    assert.equal(savedFiles[0]?.mimeType, blob.type);
    assert.equal(savedFiles[0]?.data, undefined);
    assert.equal(removedDirectories.length, 1);
  } else assert.equal(savedFiles.length, 0);
  process.exit(0);
}
if (scenario === "android-image-copy" || scenario === "ios-image-copy") {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  await native.copyImage(new Blob([bytes], { type: "image/png" }));
  if (android) {
    assert.equal(copiedImages.length, 1);
    assert.ok(String(copiedImages[0]?.uri).endsWith("/clipboard.png"));
    assert.deepEqual(Buffer.concat(cacheChunks), Buffer.from(bytes));
    assert.equal(clipboardWrites.length, 0, "Android must copy an image URI, not plain Base64 text");
    assert.equal(removedDirectories.length, 0, "recipient still needs the image URI");
  } else assert.equal(clipboardWrites[0]?.image, "data:image/png;base64," + Buffer.from(bytes).toString("base64"));
  process.exit(0);
}
if (scenario?.startsWith("android-scan-")) {
  if (scenario === "android-scan-failure") await assert.rejects(native.scanPairingQr(), /permission denied/);
  else assert.equal(await native.scanPairingQr(), scenario === "android-scan-cancel" ? null : "bridgecodex://connect?fixture=pairing");
  assert.equal(nativeScans.length, 1);
  assert.equal(nativeScans[0]?.cameraDirection, 1);
  process.exit(0);
}
if (scenario === "android-motion-permission") {
  const rows = new Map<string, string>();
  let permission = "denied";
  Object.assign(windowEvents, { localStorage: { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); } },
    DeviceMotionEvent: { requestPermission: async () => permission } });
  await assert.rejects(native.setShakeEnabled(true), /传感器权限/);
  assert.equal(rows.size, 0);
  await native.setShakeEnabled(false);
  assert.equal([...rows.values()][0], "false");
  permission = "granted";
  await native.setShakeEnabled(true);
  assert.equal([...rows.values()][0], "true");
  process.exit(0);
}

if (scenario?.startsWith("android-apk-")) {
  const update = { available: true as const, revision: "a".repeat(64), sha256: "a".repeat(64), size: 100,
    modifiedAt: new Date().toISOString(), packageName: "dev.feishu.codex.bridge", versionCode: 200, versionName: "0.5.0",
    downloadUrl: url, server: "https://bridge.fixture" };
  const phases: Array<{ phase: string; uri?: string }> = [];
  const install = scenario !== "android-apk-save";
  const pending = native.prepareApkUpdate(update, token, install, undefined, (phase, uri) => phases.push({ phase, uri }));
  const result = pending.then((uri) => ({ uri, error: null }), (error: Error) => ({ uri: null, error }));
  await until(() => transfers.length === 1);
  assert.equal(installations.length, 0);
  assert.equal(verifications.length, 0);
  assert.equal(transfers[0]!.options.disableRedirects, true);
  transfers[0]!.pending.resolve();
  const completed = await result;
  assert.equal(verifications[0]?.sha256, update.sha256);
  assert.equal(verifications[0]?.size, 100);
  if (scenario === "android-apk-invalid") {
    assert.ok(completed.error);
    assert.equal(installations.length, 0);
    assert.equal(apkSaves.length, 0);
    assert.ok(removedDirectories.length > 0);
    assert.equal(phases.at(-1)?.phase, "error");
    assert.equal(phases.at(-1)?.uri, undefined);
  } else if (scenario === "android-apk-cancel") {
    assert.ok(completed.error);
    assert.equal(phases.at(-1)?.phase, "error");
    assert.ok(phases.at(-1)?.uri);
    assert.equal(removedDirectories.length, 0);
  } else {
    assert.equal(completed.error, null);
    assert.equal(installations.length, install ? 1 : 0);
    assert.equal(apkSaves.length, install ? 0 : 1);
    assert.deepEqual(phases.map((item) => item.phase), install ? ["downloading", "downloaded", "installer-opened"] : ["downloading", "downloaded"]);
    assert.equal(getMobileDownloads()[0]?.state, "done");
  }
  process.exit(0);
}

if (scenario === "android") {
  const downloading = native.downloadBridgeFile(url, "report.pdf", token);
  assert.equal(getMobileDownloads()[0]?.state, "preparing");
  assert.equal(enqueues.length, 1);
  assert.deepEqual(enqueues[0]!.options, { url, token, fileName: "report.pdf", mimeType: "application/pdf", userAgent });
  enqueues[0]!.pending.resolve({ id: 701, fileName: "report (1).pdf" });
  await downloading;
  assert.equal(getMobileDownloads()[0]?.state, "queued");
  assert.equal(hasAndroidMobileDownloads(), true);
  assert.deepEqual(queries[0]?.ids, [701]);
  queries[0]!.pending.resolve({ downloads: [{
    id: 701, fileName: "report (1).pdf", state: "downloading", downloadedBytes: 100, totalBytes: 100,
  }] });
  await until(() => timers.size === 1);
  assert.equal(getMobileDownloads()[0]?.downloadedBytes, 100);
  assert.equal(getMobileDownloads()[0]?.state, "downloading");

  documentEvents.visibilityState = "hidden";
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  assert.equal(timers.size, 0, "backgrounding clears the scheduled progress poll");
  windowEvents.dispatchEvent(new Event(MOBILE_RESUME_EVENT));
  assert.equal(queries.length, 1, "a resume signal must not query while the document is hidden");
  assert.equal(getMobileDownloads()[0]?.state, "downloading");

  documentEvents.visibilityState = "visible";
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  await until(() => queries.length === 2);
  assert.deepEqual(queries[1]?.ids, [701]);
  // A status request already in flight can finish after the App backgrounds.
  documentEvents.visibilityState = "hidden";
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  queries[1]!.pending.resolve({ downloads: [{
    id: 701, fileName: "report (1).pdf", state: "downloading", downloadedBytes: 100, totalBytes: 100,
  }] });
  for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
  assert.equal(timers.size, 0, "an in-flight response must not restart polling in the background");
  assert.equal(queries.length, 2);

  documentEvents.visibilityState = "visible";
  windowEvents.dispatchEvent(new Event(MOBILE_RESUME_EVENT));
  await until(() => queries.length === 3);
  assert.deepEqual(queries[2]?.ids, [701]);
  queries[2]!.pending.resolve({ downloads: [{
    id: 701, fileName: "report (1).pdf", state: "done", downloadedBytes: 100, totalBytes: 100,
  }] });
  await until(() => !hasAndroidMobileDownloads());
  assert.equal(getMobileDownloads()[0]?.state, "done");
  assert.equal(getMobileDownloads()[0]?.savedName, "report (1).pdf");
  assert.match(getMobileDownloads()[0]?.message ?? "", /已保存到系统 Downloads/);
  assert.equal(timers.size, 0);
} else if (scenario === "android-invalid-id") {
  const downloading = native.downloadBridgeFile(url, "invalid.zip", token);
  const failed = assert.rejects(downloading, /有效的下载任务/);
  enqueues[0]!.pending.resolve({ id: -1, fileName: "invalid.zip" });
  await failed;
  assert.equal(getMobileDownloads()[0]?.state, "error");
  assert.equal(hasAndroidMobileDownloads(), false);
  assert.equal(queries.length, 0);
} else if (scenario === "ios-serial") {
  const first = native.downloadBridgeFile(url, "first.txt", token);
  const firstFailed = assert.rejects(first, /transfer failed/);
  const second = native.downloadBridgeFile(url, "second.txt", token);
  await until(() => transfers.length === 1);
  await until(() => getMobileDownloads()[1]?.state === "queued");
  assert.equal(getMobileDownloads()[0]?.state, "downloading");
  assert.equal(listeners.size, 1);
  emit({ bytes: 7 });
  assert.equal(getMobileDownloads()[0]?.downloadedBytes, 7);
  assert.equal(getMobileDownloads()[1]?.downloadedBytes, 0);

  transfers[0]!.pending.reject(new Error("transfer failed"));
  await firstFailed;
  await until(() => transfers.length === 2);
  assert.equal(removedListeners, 1);
  assert.equal(listeners.size, 1);
  assert.equal(removedDirectories.length, 1);
  assert.equal(getMobileDownloads()[0]?.state, "error");
  assert.equal(getMobileDownloads()[1]?.state, "downloading");
  emit({ bytes: 19 });
  assert.equal(getMobileDownloads()[0]?.downloadedBytes, 7);
  assert.equal(getMobileDownloads()[1]?.downloadedBytes, 19);
  transfers[1]!.pending.resolve();
  await until(() => shares.length === 1);
  assert.equal(listeners.size, 0);
  shares[0]!.pending.resolve({ activityType: "fixture-save" });
  await second;
  assert.equal(removedListeners, 2);
  assert.equal(getMobileDownloads()[1]?.state, "done");
  assert.equal(getMobileDownloads()[1]?.downloadedBytes, 100);
  assert.equal(getMobileDownloads()[1]?.totalBytes, 100);
  assert.equal(getMobileDownloads()[0]?.state, "error");
  assert.equal(getMobileDownloads()[0]?.downloadedBytes, 7);
} else if (["ios-completion", "ios-cancel", "ios-share-failure"].includes(scenario ?? "")) {
  const downloading = native.downloadBridgeFile(url, "report.pdf", token);
  const shareFailed = scenario === "ios-share-failure" ? assert.rejects(downloading, /share service unavailable/) : null;
  await until(() => transfers.length === 1);
  assert.equal(getMobileDownloads()[0]?.state, "downloading");
  assert.deepEqual(transfers[0]!.options.headers, { Authorization: "Bearer " + token, "User-Agent": userAgent });
  assert.equal(transfers[0]!.options.progress, true);
  assert.equal(transfers[0]!.options.disableRedirects, true);
  emit({ type: "upload", bytes: 999 });
  emit({ url: url + "?other=1", bytes: 999 });
  assert.equal(getMobileDownloads()[0]?.downloadedBytes, 0);
  emit();
  assert.equal(getMobileDownloads()[0]?.downloadedBytes, 11);
  assert.equal(getMobileDownloads()[0]?.totalBytes, null);
  emit({ bytes: 42, lengthComputable: true, contentLength: 100 });
  assert.equal(getMobileDownloads()[0]?.downloadedBytes, 42);
  assert.equal(getMobileDownloads()[0]?.totalBytes, 100);
  assert.equal(getMobileDownloads()[0]?.state, "downloading");
  transfers[0]!.pending.resolve();
  await until(() => shares.length === 1);
  assert.equal(listeners.size, 0);
  assert.equal(removedListeners, 1);
  assert.equal(getMobileDownloads()[0]?.state, "sharing");
  assert.equal(getMobileDownloads()[0]?.downloadedBytes, 100, "saved file size completes progress even without a final transfer event");
  assert.equal(getMobileDownloads()[0]?.totalBytes, 100);
  assert.deepEqual(shares[0]!.options.files, [transfers[0]!.options.path]);

  if (scenario === "ios-completion") {
    shares[0]!.pending.resolve({ activityType: "fixture-save" });
    await downloading;
    assert.equal(getMobileDownloads()[0]?.state, "done");
    assert.equal(getMobileDownloads()[0]?.downloadedBytes, 100);
    assert.equal(getMobileDownloads()[0]?.totalBytes, 100);
    assert.match(getMobileDownloads()[0]?.message ?? "", /保存结果请在所选应用中查看/);
    assert.doesNotMatch(getMobileDownloads()[0]?.message ?? "", /取消/);
  } else if (scenario === "ios-cancel") {
    shares[0]!.pending.reject(new Error("Share canceled"));
    await downloading;
    assert.equal(getMobileDownloads()[0]?.state, "done");
    assert.equal(getMobileDownloads()[0]?.downloadedBytes, 100);
    assert.equal(getMobileDownloads()[0]?.totalBytes, 100);
    assert.match(getMobileDownloads()[0]?.message ?? "", /已取消保存／分享/);
  } else {
    shares[0]!.pending.reject(new Error("share service unavailable"));
    await shareFailed;
    assert.equal(getMobileDownloads()[0]?.state, "error");
    assert.equal(getMobileDownloads()[0]?.message, "share service unavailable");
  }
  assert.equal(removedDirectories.length, 0, "recipients must retain access to the downloaded file");
} else {
  throw new Error("Unknown native download fixture scenario: " + scenario);
}

assert.equal(listeners.size, 0);
assert.doesNotMatch(JSON.stringify(getMobileDownloads()), /fixture-private-token|bridge\.fixture/);
