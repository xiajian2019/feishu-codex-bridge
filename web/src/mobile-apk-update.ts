export interface MobileApkUpdate {
  available: true;
  revision: string;
  sha256: string;
  size: number;
  modifiedAt: string;
  packageName: string;
  versionCode: number;
  versionName: string;
  downloadUrl: string;
  server: string;
}
export type ApkUpdatePhase = "available" | "downloading" | "downloaded" | "installer-opened" | "installed" | "error";
export interface ApkUpdateState {
  revision: string;
  phase: ApkUpdatePhase;
  snoozeUntil: number;
  uri?: string;
}
export function parseApkUpdate(value: unknown, server: string): MobileApkUpdate {
  const row = value as Partial<MobileApkUpdate> | null;
  if (!row || row.available !== true || !/^[a-f0-9]{64}$/.test(row.sha256 ?? "") || row.revision !== row.sha256
    || !Number.isSafeInteger(row.size) || row.size! < 1 || !Number.isSafeInteger(row.versionCode) || row.versionCode! < 1
    || row.packageName !== "dev.feishu.codex.bridge" || typeof row.versionName !== "string" || !row.versionName
    || !Number.isFinite(Date.parse(row.modifiedAt ?? ""))) throw new Error("后端更新信息不完整，请升级后端或重新构建 APK。");
  const origin = new URL(server).origin;
  const url = new URL(row.downloadUrl ?? "", origin);
  const revisionPath = url.pathname === "/api/mobile/update/download/" + row.sha256 && !url.search;
  const legacyCompatiblePath = url.pathname === "/api/mobile/update/download"
    && url.searchParams.size === 1 && url.searchParams.get("revision") === row.sha256;
  if (url.origin !== origin || url.username || url.password || url.hash || !(revisionPath || legacyCompatiblePath)) throw new Error("更新文件地址无效。");
  return { ...row, server: origin, downloadUrl: url.href } as MobileApkUpdate;
}
export function apkUpdateStorageKey(server: string): string {
  return "bridge.mobile.apk-update.v2:" + encodeURIComponent(new URL(server).origin);
}
export function readApkUpdateState(storage: Storage, update: MobileApkUpdate): ApkUpdateState {
  try {
    const state = JSON.parse(storage.getItem(apkUpdateStorageKey(update.server)) ?? "null") as ApkUpdateState | null;
    if (state?.revision === update.revision && ["available", "downloading", "downloaded", "installer-opened", "installed", "error"].includes(state.phase)) {
      return { ...state, phase: state.phase === "downloading" ? "error" : state.phase, snoozeUntil: Number.isFinite(state.snoozeUntil) ? state.snoozeUntil : 0 };
    }
  } catch { /* Local state never substitutes the installed package version. */ }
  return { revision: update.revision, phase: "available", snoozeUntil: 0 };
}
export function shouldOfferApkUpdate(update: MobileApkUpdate, installedBuild: number, state: ApkUpdateState, now = Date.now()): boolean {
  return update.versionCode > installedBuild && state.snoozeUntil <= now;
}
