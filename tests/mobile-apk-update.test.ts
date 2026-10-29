import { expect, it } from "bun:test";
import { parseApkUpdate, readApkUpdateState, shouldOfferApkUpdate, apkUpdateStorageKey } from "../web/src/mobile-apk-update.js";
import { allocateMobileVersion } from "../scripts/mobile-version.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hash = "a".repeat(64);
const metadata = { available: true, revision: hash, sha256: hash, size: 100, modifiedAt: "2026-10-28T00:00:00Z",
  versionCode: 200, versionName: "0.5.0", packageName: "dev.feishu.codex.bridge", downloadUrl: "/api/mobile/update/download/" + hash };
it("validates both update flows against the selected origin, immutable revision and complete manifest", () => {
  const update = parseApkUpdate(metadata, "https://bridge.fixture");
  expect(update.downloadUrl).toBe("https://bridge.fixture" + metadata.downloadUrl);
  expect(parseApkUpdate({ ...metadata, downloadUrl: "/api/mobile/update/download?revision=" + hash }, "https://bridge.fixture").sha256).toBe(hash);
  for (const patch of [ { downloadUrl: "https://evil.fixture" + metadata.downloadUrl }, { downloadUrl: "https://user:secret@bridge.fixture" + metadata.downloadUrl },
    { downloadUrl: metadata.downloadUrl + "?redirect=evil" }, { downloadUrl: "/api/mobile/update/download" }, { size: 0 },
    { sha256: "wrong" }, { packageName: "other.app" }, { versionCode: 0 } ]) {
    expect(() => parseApkUpdate({ ...metadata, ...patch }, "https://bridge.fixture")).toThrow();
  }
});
it("offers a newer package on first check and after cancelled installation, isolating snooze per environment", () => {
  const update = parseApkUpdate(metadata, "https://bridge.fixture");
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null } as Storage;
  let state = readApkUpdateState(storage, update);
  expect(shouldOfferApkUpdate(update, 100, state)).toBe(true);
  for (const phase of ["downloaded", "installer-opened", "error", "installed"] as const) {
    state = { ...state, phase };
    expect(shouldOfferApkUpdate(update, 100, state)).toBe(true);
    expect(shouldOfferApkUpdate(update, 200, state)).toBe(false);
  }
  values.set(apkUpdateStorageKey(update.server), JSON.stringify({ ...state, snoozeUntil: 1000 }));
  expect(shouldOfferApkUpdate(update, 100, readApkUpdateState(storage, update), 999)).toBe(false);
  expect(shouldOfferApkUpdate(update, 100, readApkUpdateState(storage, update), 1000)).toBe(true);
  const other = parseApkUpdate(metadata, "https://other.fixture");
  expect(shouldOfferApkUpdate(other, 100, readApkUpdateState(storage, other), 999)).toBe(true);
  values.set(apkUpdateStorageKey(update.server), JSON.stringify({ ...state, phase: "downloading" }));
  expect(readApkUpdateState(storage, update).phase).toBe("error");
});
it("allocates increasing Android versions across same-instant builds and clock rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-version-"));
  try {
    await mkdir(join(root, "android"));
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.5.9" }));
    const a = allocateMobileVersion(root, Date.UTC(2026, 9, 28));
    const b = allocateMobileVersion(root, Date.UTC(2026, 9, 28));
    const c = allocateMobileVersion(root, Date.UTC(2025, 0, 1));
    expect([a.versionName, b.versionCode, c.versionCode]).toEqual(["0.5.9", a.versionCode + 1, a.versionCode + 2]);
    expect(() => allocateMobileVersion(root, Date.now(), a.versionCode)).toThrow("versionCode");
  } finally { await rm(root, { recursive: true, force: true }); }
});
