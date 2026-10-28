import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Readable } from "node:stream";
import { DownloadUploadsService, DOWNLOAD_UPLOAD_CHUNK_BYTES } from "../src/download-uploads.js";
import { StateDatabase } from "../src/db.js";
import { DashboardServer } from "../src/web.js";
import { WebPairingAuth } from "../src/web-auth.js";
import type { IncomingMessage } from "node:http";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bridge-download-upload-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "Downloads");
  const service = new DownloadUploadsService({ directory });
  cleanups.push(() => service.dispose());
  return { root, directory, service };
}

describe("Downloads upload storage", () => {
  it("accepts independent parts concurrently and assembles them in order", async () => {
    const { service, directory } = await fixture();
    const size = DOWNLOAD_UPLOAD_CHUNK_BYTES * 2 + 17;
    const upload = await service.create("device-a", "parallel.bin", size, "parts");
    const parts = [
      Buffer.alloc(DOWNLOAD_UPLOAD_CHUNK_BYTES, 0x61),
      Buffer.alloc(DOWNLOAD_UPLOAD_CHUNK_BYTES, 0x62),
      Buffer.alloc(17, 0x63),
    ];
    await Promise.all(parts.map((part, index) => service.appendPart(upload.id, "device-a", index, Readable.from([part]))));
    expect(service.status(upload.id, "device-a")).toMatchObject({ protocol: "parts", partCount: 3, parts: [
      { index: 0, sizeBytes: DOWNLOAD_UPLOAD_CHUNK_BYTES },
      { index: 1, sizeBytes: DOWNLOAD_UPLOAD_CHUNK_BYTES },
      { index: 2, sizeBytes: 17 },
    ] });
    const result = await service.complete(upload.id, "device-a");
    expect((await readFile(result.filePath)).equals(Buffer.concat(parts))).toBe(true);
    expect((await readdir(directory)).filter((name) => name.startsWith(".bridge-upload-"))).toEqual([]);
  });

  it("accepts multi-gigabyte metadata, owns upload state per device and sanitizes destination names", async () => {
    const { service, directory } = await fixture();
    const large = await service.create("device-a", "video.mov", 8 * 1024 ** 3);
    expect(large.sizeBytes).toBe(8 * 1024 ** 3);
    expect(() => service.status(large.id, "device-b")).toThrow("不存在");
    await service.cancel(large.id, "device-b");
    expect(service.status(large.id, "device-a").offset).toBe(0);
    await service.cancel(large.id, "device-a");
    const unsafe = await service.create("device-a", "../../目录/文件.txt", 0);
    const saved = await service.complete(unsafe.id, "device-a");
    expect(saved.filePath.startsWith(directory + "/")).toBe(true);
    expect(saved.fileName).not.toContain("/");
    expect((await stat(saved.filePath)).size).toBe(0);
    await expect(service.create("device-a", "invalid", -1)).rejects.toThrow("大小");
  });

  it("rolls back partial chunks, rejects wrong offsets, and saves without overwriting files or symlinks", async () => {
    const { service, root, directory } = await fixture();
    const upload = await service.create("a", "report.txt", 6);
    await expect(service.append(upload.id, "a", 0, Readable.from((async function* () {
      yield Buffer.from("bad"); throw new Error("fixture disconnect");
    })()))).rejects.toThrow("disconnect");
    expect(service.status(upload.id, "a").offset).toBe(0);
    await expect(service.append(upload.id, "a", 1, Readable.from(["abcdef"]))).rejects.toThrow("进度");
    await service.append(upload.id, "a", 0, Readable.from(["abc"]));
    await expect(service.complete(upload.id, "a")).rejects.toThrow("尚未");
    await service.append(upload.id, "a", 3, Readable.from(["def"]));
    const outside = join(root, "original");
    await writeFile(outside, "keep existing");
    await symlink(outside, join(directory, "report.txt"));
    const [saved, duplicate] = await Promise.all([service.complete(upload.id, "a"), service.complete(upload.id, "a")]);
    expect(duplicate).toEqual(saved);
    expect(saved.fileName).toBe("report (1).txt");
    expect(await readFile(saved.filePath, "utf8")).toBe("abcdef");
    expect(await readFile(outside, "utf8")).toBe("keep existing");
    expect(await service.complete(upload.id, "a")).toEqual(saved);
    await service.cancel(upload.id, "a");
    expect(await readFile(saved.filePath, "utf8")).toBe("abcdef");
  });

  it("cancels in-flight writes and removes partial files without touching completed files", async () => {
    const { service, directory } = await fixture();
    const upload = await service.create("a", "partial.bin", 1_000_000);
    const input = new PassThrough();
    const pending = service.append(upload.id, "a", 0, input).catch(() => undefined);
    input.write(Buffer.alloc(100));
    await service.cancel(upload.id, "a");
    await pending;
    expect(await readdir(directory)).toEqual([]);
    const excessive = await service.create("a", "large.bin", 8 * 1024 ** 3);
    await expect(service.append(excessive.id, "a", 0, Readable.from([Buffer.alloc(DOWNLOAD_UPLOAD_CHUNK_BYTES + 1)]))).rejects.toThrow("超出");
    expect(service.status(excessive.id, "a").offset).toBe(0);
    await service.dispose();
    expect(await readdir(directory)).toEqual([]);
  });
});

it("protects upload mutations and device ownership, serves the SPA deep link, and transfers more than 100 MiB", async () => {
  const { service, root, directory } = await fixture();
  await service.dispose();
  const webRoot = join(root, "web");
  await mkdir(webRoot); await writeFile(join(webRoot, "index.html"), "<html>Upload fixture</html>");
  const db = new StateDatabase(":memory:"); cleanups.push(() => db.close());
  const auth = new WebPairingAuth({ db });
  const remote = { headers: {}, socket: { remoteAddress: "203.0.113.1" } } as IncomingMessage;
  const first = auth.claimPairing(remote, auth.startPairing().code);
  const second = auth.claimPairing(remote, auth.startPairing().code);
  const server = new DashboardServer({ db, auth, host: "127.0.0.1", port: 0, modes: [], downloadsDirectory: directory, webRoot, cleanupExpiredStagedAttachments: false });
  cleanups.push(() => server.stop());
  const base = await server.start();
  const cookie = { Cookie: `bridge_session=${first}` };
  const action = await (await fetch(base + "/api/session", { headers: cookie })).json() as { actionToken: string };
  const headers = { ...cookie, "X-Bridge-Action-Token": action.actionToken, Origin: base };
  const endpoint = base + "/api/download-uploads";
  const body = JSON.stringify({ fileName: "large-test.bin", sizeBytes: 100 * 1024 * 1024 + 17 });
  expect((await fetch(endpoint, { method: "POST", body, headers: { "Content-Type": "application/json" } })).status).toBe(401);
  expect((await fetch(endpoint, { method: "POST", body, headers: cookie })).status).toBe(403);
  expect((await fetch(endpoint, { method: "POST", body, headers: { ...headers, Origin: "https://foreign.test" } })).status).toBe(403);
  const created = await fetch(endpoint, { method: "POST", body, headers: { ...headers, "Content-Type": "application/json" } });
  expect(created.status).toBe(201);
  const upload = await created.json() as { id: string; chunkBytes: number; sizeBytes: number };
  expect((await fetch(endpoint + "/" + upload.id, { headers: { Cookie: `bridge_session=${second}` } })).status).toBe(404);
  for (const [method, suffix] of [["PUT", "?offset=0"], ["POST", "/complete"], ["DELETE", ""]]) {
    expect((await fetch(`${endpoint}/${upload.id}${suffix}`, { method, headers: cookie })).status).toBe(403);
  }
  expect((await fetch(endpoint + "/" + upload.id + "/complete", { method: "POST", headers })).status).toBe(409);
  const chunk = Buffer.alloc(upload.chunkBytes, 0x65);
  for (let offset = 0; offset < upload.sizeBytes;) {
    const bytes = Math.min(upload.chunkBytes, upload.sizeBytes - offset);
    const response = await fetch(`${endpoint}/${upload.id}?offset=${offset}`, { method: "PUT", headers, body: chunk.subarray(0, bytes) });
    expect(response.status).toBe(200);
    const next = await response.json() as { offset: number };
    expect(next.offset).toBe(offset + bytes);
    offset = next.offset;
  }
  const completed = await fetch(`${endpoint}/${upload.id}/complete`, { method: "POST", headers });
  expect(completed.status).toBe(200);
  const saved = await completed.json() as { filePath: string; sizeBytes: number };
  expect(saved.sizeBytes).toBe(upload.sizeBytes);
  expect((await stat(saved.filePath)).size).toBe(upload.sizeBytes);
  const handle = await open(saved.filePath, "r");
  try {
    const sample = Buffer.alloc(17);
    await handle.read(sample, 0, 17, upload.sizeBytes - 17);
    expect(sample.equals(Buffer.alloc(17, 0x65))).toBe(true);
  } finally { await handle.close(); }
  const page = await fetch(base + "/system-management/uploads", { headers: cookie });
  expect(page.status).toBe(200); expect(await page.text()).toContain("Upload fixture");
  expect((await fetch(`${endpoint}/${upload.id}`, { method: "DELETE", headers })).status).toBe(200);
  expect((await stat(saved.filePath)).size).toBe(upload.sizeBytes);
  expect((await readdir(directory)).filter((name) => name.startsWith(".bridge-upload-"))).toEqual([]);
}, 30_000);
