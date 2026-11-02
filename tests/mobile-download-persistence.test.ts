import { expect, it } from "bun:test";
import { createMobileDownloadManager } from "../web/src/mobile-download-manager.js";
import { pairingCameraFailure } from "../web/src/pairing-scanner.js";

function storage() {
  const rows = new Map<string, string>();
  return { rows, getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
}
it("restores native IDs after process loss and obtains actual OS results without persisting URLs or credentials", async () => {
  const disk = storage(); const first = createMobileDownloadManager(); first.restore(disk, "server-device-A");
  const id = first.start("report.pdf", "downloads"); first.trackAndroid(id, 71, "report (1).pdf");
  first.update(id, { downloadedBytes: 99, token: "private-token", url: "https://secret.fixture" } as never);
  expect(disk.getItem("server-device-A")).not.toContain("private-token");
  expect(disk.getItem("server-device-A")).not.toContain("https:");
  const restarted = createMobileDownloadManager(); restarted.restore(disk, "server-device-A");
  expect(restarted.getSnapshot()[0]).toMatchObject({ nativeId: 71, state: "paused", downloadedBytes: 99 });
  await restarted.refreshAndroid(async (ids) => {
    expect(ids).toEqual([71]);
    return { downloads: [{ id: 71, fileName: "report (1).pdf", state: "done", downloadedBytes: 100, totalBytes: 100 }] };
  });
  expect(restarted.getSnapshot()[0]?.state).toBe("done");
});
it("does not mix restored transfers or late callbacks across device scopes, and clears only the current scope", async () => {
  const disk = storage(); const manager = createMobileDownloadManager();
  manager.restore(disk, "A"); const id = manager.start("A.pdf", "downloads"); manager.trackAndroid(id, 1, "A.pdf");
  let resolve!: (value: { downloads: [] }) => void;
  const pending = manager.refreshAndroid(() => new Promise((done) => { resolve = done; }));
  manager.restore(disk, "B"); const next = manager.start("B.pdf", "downloads"); manager.trackAndroid(next, 2, "B.pdf");
  resolve({ downloads: [] }); await pending;
  expect(manager.getSnapshot()[0]).toMatchObject({ fileName: "B.pdf", state: "queued" });
  manager.clearScope(); expect(disk.getItem("B")).toBeNull(); expect(disk.getItem("A")).not.toBeNull();
  manager.restore(disk, "A"); expect(manager.getSnapshot()[0]?.nativeId).toBe(1);
});
it("marks interrupted foreground-only transfers as failed and does not let stale OS results undo cancellation", async () => {
  const disk = storage(); const manager = createMobileDownloadManager(); manager.restore(disk, "A");
  manager.start("export.json", "share"); const id = manager.start("file.pdf", "downloads"); manager.trackAndroid(id, 10, "file.pdf");
  const reloaded = createMobileDownloadManager(); reloaded.restore(disk, "A");
  expect(reloaded.getSnapshot()[0]).toMatchObject({ state: "error", message: expect.stringContaining("中断") });
  reloaded.cancelAndroid(id);
  expect(reloaded.getSnapshot()[1]?.state).toBe("cancelled");
  reloaded.update(id, { state: "done" }); expect(reloaded.getSnapshot()[1]?.state).toBe("cancelled");
});
it("gives distinct permission, camera-busy and missing-camera recovery hints", () => {
  expect(pairingCameraFailure(new DOMException("", "NotAllowedError"), true)).toContain("系统设置");
  expect(pairingCameraFailure(new DOMException("", "NotAllowedError"), false)).toContain("站点权限");
  expect(pairingCameraFailure(new DOMException("", "NotReadableError"), true)).toContain("占用");
  expect(pairingCameraFailure(new DOMException("", "NotFoundError"), true)).toContain("没有找到");
});
