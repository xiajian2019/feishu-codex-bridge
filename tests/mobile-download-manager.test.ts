import { expect, it } from "bun:test";
import {
  createMobileDownloadManager,
  isMobileDownloadActive,
  type NativeDownloadStatus,
} from "../web/src/mobile-download-manager.js";

function nativeStatus(id: number, patch: Partial<NativeDownloadStatus> = {}): NativeDownloadStatus {
  return { id, fileName: `download-${id}.zip`, state: "downloading", downloadedBytes: 25, totalBytes: 100, ...patch };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

it("keeps a fully transferred Android download active until the OS confirms completion", async () => {
  const manager = createMobileDownloadManager();
  const id = manager.start("archive.zip", "downloads");
  manager.trackAndroid(id, 101, "archive.zip");

  await manager.refreshAndroid(async () => ({ downloads: [nativeStatus(101, { downloadedBytes: 100 })] }));
  expect(manager.getSnapshot()[0]?.state).toBe("downloading");
  expect(isMobileDownloadActive(manager.getSnapshot()[0]!)).toBe(true);
  expect(manager.hasAndroidDownloads()).toBe(true);

  await manager.refreshAndroid(async () => ({ downloads: [nativeStatus(101, {
    state: "done", downloadedBytes: 100, fileName: "archive (1).zip",
  })] }));
  expect(manager.getSnapshot()[0]).toMatchObject({
    id, state: "done", savedName: "archive (1).zip", message: "已保存到系统 Downloads",
  });
  expect(manager.hasAndroidDownloads()).toBe(false);

  manager.update(id, { state: "downloading", downloadedBytes: 5 });
  expect(manager.getSnapshot()[0]?.state).toBe("done");
  expect(manager.getSnapshot()[0]?.downloadedBytes).toBe(100);
});

it("matches concurrent system results by native ID and keeps per-file failures separate", async () => {
  const manager = createMobileDownloadManager();
  const first = manager.start("first.zip", "downloads");
  const second = manager.start("second.zip", "downloads");
  manager.trackAndroid(first, 41, "first.zip");
  manager.trackAndroid(second, 42, "second.zip");

  await manager.refreshAndroid(async (ids) => {
    expect(ids).toEqual([41, 42]);
    return { downloads: [
      nativeStatus(42, { state: "error", downloadedBytes: 12, reason: "存储空间不足" }),
      nativeStatus(41, { downloadedBytes: 73, totalBytes: 200 }),
    ] };
  });
  expect(manager.getSnapshot().find((task) => task.id === first)).toMatchObject({
    state: "downloading", downloadedBytes: 73, totalBytes: 200,
  });
  expect(manager.getSnapshot().find((task) => task.id === second)).toMatchObject({
    state: "error", downloadedBytes: 12, message: "存储空间不足",
  });

  await manager.refreshAndroid(async (ids) => {
    expect(ids).toEqual([41]);
    return { downloads: [nativeStatus(41, { state: "done" })] };
  });
  expect(manager.hasAndroidDownloads()).toBe(false);
});

it("reports a missing system download as a failure and stops polling its ID", async () => {
  const manager = createMobileDownloadManager();
  const id = manager.start("removed.zip", "downloads");
  manager.trackAndroid(id, 70, "removed.zip");

  await manager.refreshAndroid(async () => ({ downloads: [] }));
  expect(manager.getSnapshot()[0]?.state).toBe("error");
  expect(manager.getSnapshot()[0]?.message).toContain("找不到此下载");
  expect(manager.hasAndroidDownloads()).toBe(false);
  let queriedAgain = false;
  await manager.refreshAndroid(async () => { queriedAgain = true; return { downloads: [] }; });
  expect(queriedAgain).toBe(false);
});

it("preserves unknown content length instead of inventing a percentage or completion", async () => {
  const manager = createMobileDownloadManager();
  const id = manager.start("stream.bin", "downloads");
  manager.trackAndroid(id, 80, "stream.bin");
  for (const totalBytes of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    await manager.refreshAndroid(async () => ({ downloads: [nativeStatus(80, { downloadedBytes: 8192, totalBytes })] }));
    expect(manager.getSnapshot()[0]).toMatchObject({ state: "downloading", downloadedBytes: 8192, totalBytes: null });
    expect(manager.hasAndroidDownloads()).toBe(true);
  }
});

it("retains an active download after a transient query failure and recovers on the next poll", async () => {
  const manager = createMobileDownloadManager();
  const id = manager.start("network.zip", "downloads");
  manager.trackAndroid(id, 90, "network.zip");
  await manager.refreshAndroid(async () => ({ downloads: [nativeStatus(90, { downloadedBytes: 45 })] }));
  await manager.refreshAndroid(async () => { throw new Error("native bridge temporarily unavailable"); });

  expect(manager.getSnapshot()[0]).toMatchObject({ state: "paused", downloadedBytes: 45 });
  expect(manager.getSnapshot()[0]?.message).toContain("正在重试");
  expect(isMobileDownloadActive(manager.getSnapshot()[0]!)).toBe(true);
  expect(manager.hasAndroidDownloads()).toBe(true);

  await manager.refreshAndroid(async (ids) => {
    expect(ids).toEqual([90]);
    return { downloads: [nativeStatus(90, { downloadedBytes: 75 })] };
  });
  expect(manager.getSnapshot()[0]).toMatchObject({ state: "downloading", downloadedBytes: 75 });
  expect(manager.getSnapshot()[0]?.message).toBeUndefined();
});

it("does not let dismissal or clear-finished hide active transfers", () => {
  const manager = createMobileDownloadManager();
  const active = manager.start("active.zip", "downloads");
  const complete = manager.start("complete.zip", "downloads");
  const failed = manager.start("failed.zip", "share");
  manager.update(complete, { state: "done" });
  manager.fail(failed, new Error("保存失败"));

  manager.dismiss(active);
  expect(manager.getSnapshot().some((task) => task.id === active)).toBe(true);
  manager.dismiss(complete);
  expect(manager.getSnapshot().some((task) => task.id === complete)).toBe(false);
  manager.clearFinished();
  expect(manager.getSnapshot().map((task) => task.id)).toEqual([active]);
});

it("bounds finished history while preserving all active transfers", () => {
  const manager = createMobileDownloadManager();
  const active = Array.from({ length: 25 }, (_, index) => manager.start(`active-${index}.zip`, "downloads"));
  const finished: string[] = [];
  for (let index = 0; index < 35; index += 1) {
    const id = manager.start(`finished-${index}.zip`, "downloads");
    finished.push(id);
    if (index % 2) manager.fail(id, new Error("fixture failure"));
    else manager.update(id, { state: "done" });
  }

  const snapshot = manager.getSnapshot();
  expect(snapshot.filter(isMobileDownloadActive).map((task) => task.id)).toEqual(active);
  expect(snapshot.filter((task) => !isMobileDownloadActive(task)).map((task) => task.id)).toEqual(finished.slice(-20));
});

it("keeps snapshot references stable between changes and notifies subscribers of new state", () => {
  const manager = createMobileDownloadManager();
  const initial = manager.getSnapshot();
  expect(manager.getSnapshot()).toBe(initial);
  const observed: ReturnType<typeof manager.getSnapshot>[] = [];
  const unsubscribe = manager.subscribe(() => observed.push(manager.getSnapshot()));
  const id = manager.start("state.zip", "downloads");
  const started = manager.getSnapshot();
  expect(started).not.toBe(initial);
  expect(manager.getSnapshot()).toBe(started);
  expect(observed).toEqual([started]);

  manager.update(id, { state: "downloading", downloadedBytes: 10, totalBytes: 20 });
  expect(manager.getSnapshot()).not.toBe(started);
  expect(started[0]?.state).toBe("preparing");
  expect(manager.getSnapshot()).toBe(manager.getSnapshot());
  expect(observed).toHaveLength(2);
  unsubscribe();
  manager.update(id, { downloadedBytes: 15 });
  expect(observed).toHaveLength(2);
});

it("deduplicates simultaneous native refreshes and retains newly tracked downloads during an in-flight poll", async () => {
  const manager = createMobileDownloadManager();
  const first = manager.start("first.zip", "downloads");
  manager.trackAndroid(first, 201, "first.zip");
  const pending = deferred<{ downloads: NativeDownloadStatus[] }>();
  const queries: number[][] = [];
  const query = (ids: number[]) => { queries.push(ids); return pending.promise; };
  const refresh = manager.refreshAndroid(query);
  const duplicate = manager.refreshAndroid(query);
  expect(duplicate).toBe(refresh);
  expect(queries).toEqual([[201]]);

  const second = manager.start("second.zip", "downloads");
  manager.trackAndroid(second, 202, "second.zip");
  pending.resolve({ downloads: [nativeStatus(201, { state: "done" })] });
  await refresh;
  expect(manager.getSnapshot().find((task) => task.id === second)?.state).toBe("queued");
  expect(manager.hasAndroidDownloads()).toBe(true);

  await manager.refreshAndroid(async (ids) => {
    expect(ids).toEqual([202]);
    return { downloads: [nativeStatus(202, { state: "done" })] };
  });
  expect(manager.getSnapshot().find((task) => task.id === second)?.state).toBe("done");
  expect(manager.hasAndroidDownloads()).toBe(false);
});
