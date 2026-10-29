import { afterEach, expect, it } from "bun:test";
import { uploadToDownloads, uploadFileInChunks } from "../web/src/download-upload.js";

const originalFetch = globalThis.fetch;
const originalXhr = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalXhr) Object.defineProperty(globalThis, "XMLHttpRequest", originalXhr);
  else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});
function installDocument() {
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
}

it("slices a multi-gigabyte file without reading it wholesale and reconciles a lost chunk response", async () => {
  installDocument();
  const size = 5 * 1024 ** 3 + 5;
  const chunkBytes = 8 * 1024 * 1024;
  let offset = 0; let lastSliceEnd = 0; let slicedEnd = 0; let puts = 0; let lost = false; let saved = false; let removed = false;
  const pendingEnds: number[] = [];
  const file = { name: "huge.bin", size, slice(start: number, end: number) {
    expect(start).toBe(lastSliceEnd); expect(end - start).toBeLessThanOrEqual(8 * 1024 * 1024);
    lastSliceEnd = end;
    pendingEnds.push(end);
    slicedEnd = end; return new Blob(["bounded fixture"]);
  } } as File;
  globalThis.fetch = (async (url, init) => {
    const path = String(url);
    if (path.endsWith("/api/session")) return Response.json({ actionToken: "fixture" });
    if (init?.method === "POST" && path.endsWith("download-uploads")) return Response.json({ id: "fixture", offset: 0, chunkBytes });
    if (init?.method === "PUT") {
      puts += 1; offset = pendingEnds[0]!;
      if (!lost) { lost = true; throw new TypeError("response lost after commit"); }
      pendingEnds.shift();
      return Response.json({ offset });
    }
    if (path.endsWith("/complete")) { saved = true; throw new TypeError("completion response lost"); }
    if (init?.method === "DELETE") { removed = true; return Response.json({ ok: true }); }
    return Response.json({ offset, ...(saved ? { result: { fileName: file.name, filePath: "/fixture/Downloads/huge.bin", sizeBytes: size } } : {}) });
  }) as typeof fetch;
  let progress = 0;
  const result = await uploadToDownloads(file, { signal: new AbortController().signal, onProgress(bytes) { progress = bytes; } });
  expect(result.sizeBytes).toBe(size);
  expect(progress).toBe(size);
  expect(puts).toBe(Math.ceil(size / (8 * 1024 * 1024)) + 1); // one lost response is retried
  expect(saved).toBe(true); expect(removed).toBe(false);
});

it("transfers a 35 MiB file in five bounded client chunks", async () => {
  installDocument();
  const size = 35 * 1024 * 1024;
  const chunkBytes = 8 * 1024 * 1024;
  let offset = 0;
  let lastSliceEnd = 0;
  let puts = 0;
  const pendingEnds: number[] = [];
  const file = {
    name: "thirty-five-megabytes.bin",
    size,
    slice(start: number, end: number) {
      expect(start).toBe(lastSliceEnd);
      expect(end - start).toBeLessThanOrEqual(chunkBytes);
      lastSliceEnd = end;
      pendingEnds.push(end);
      return new Blob([new Uint8Array(Math.min(end - start, 32))]);
    },
  } as File;
  globalThis.fetch = (async (url, init) => {
    const path = String(url);
    if (path.endsWith("/api/session")) return Response.json({ actionToken: "fixture" });
    if (init?.method === "POST" && path.endsWith("download-uploads")) return Response.json({ id: "35mb", offset: 0, chunkBytes });
    if (init?.method === "PUT") { puts += 1; return Response.json({ offset: pendingEnds.shift() }); }
    if (path.endsWith("/complete")) return Response.json({ fileName: file.name, filePath: "/fixture/Downloads/35mb.bin", sizeBytes: size });
    return Response.json({ offset });
  }) as typeof fetch;
  const result = await uploadToDownloads(file, { signal: new AbortController().signal, onProgress() {} });
  expect(result.sizeBytes).toBe(size);
  expect(puts).toBe(5);
});

it("can use the parallel parts protocol with three in-flight workers", async () => {
  installDocument();
  const size = 35 * 1024 * 1024;
  const chunkBytes = 8 * 1024 * 1024;
  const ends: number[] = [];
  const file = {
    name: "parallel.bin",
    size,
    slice(start: number, end: number) {
      ends.push(end);
      return new Blob([new Uint8Array(Math.min(32, end - start))]);
    },
  } as File;
  const completed = new Set<number>();
  let maxInFlight = 0;
  let inFlight = 0;
  globalThis.fetch = (async (url, init) => {
    const path = String(url);
    if (path.endsWith("/api/session")) return Response.json({ actionToken: "fixture" });
    if (init?.method === "POST" && path.endsWith("download-uploads")) return Response.json({ id: "parallel", offset: 0, chunkBytes, protocol: "parts", partCount: 5, parts: [] });
    if (init?.method === "PUT" && path.includes("/parts/")) {
      const index = Number(path.split("/parts/")[1]);
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1; completed.add(index);
      const partSize = index === 4 ? size - index * chunkBytes : chunkBytes;
      return Response.json({ id: "parallel", offset: 0, chunkBytes, protocol: "parts", partCount: 5,
        parts: [...completed].sort().map((part) => ({ index: part, sizeBytes: part === 4 ? size - part * chunkBytes : chunkBytes })) });
    }
    if (path.endsWith("/complete")) return Response.json({ fileName: file.name, filePath: "/fixture/Downloads/parallel.bin", sizeBytes: size });
    return Response.json({ id: "parallel", offset: 0, chunkBytes, protocol: "parts", partCount: 5,
      parts: [...completed].map((index) => ({ index, sizeBytes: index === 4 ? size - index * chunkBytes : chunkBytes })) });
  }) as typeof fetch;
  const result = await uploadToDownloads(file, { parallel: true, signal: new AbortController().signal, onProgress() {} });
  expect(result.sizeBytes).toBe(size);
  expect(ends).toHaveLength(5);
  expect(maxInFlight).toBeGreaterThan(1);
});

it("cancels between chunks and removes the unfinished server upload", async () => {
  installDocument();
  const controller = new AbortController(); let removed = false;
  const file = new File(["abcdefgh"], "cancel.txt");
  globalThis.fetch = (async (url, init) => {
    const path = String(url);
    if (path.endsWith("/api/session")) return Response.json({ actionToken: "fixture" });
    if (init?.method === "DELETE") { removed = true; return Response.json({ ok: true }); }
    if (init?.method === "PUT") return Response.json({ offset: 4 });
    return Response.json({ id: "cancel", offset: 0, chunkBytes: 4 });
  }) as typeof fetch;
  await expect(uploadToDownloads(file, { signal: controller.signal, onProgress: () => controller.abort() })).rejects.toThrow();
  expect(removed).toBe(true);
});


it("shows browser byte progress before the chunk response and returns the absolute Mac path", async () => {
  installDocument();
  const progress: number[] = [];
  const phases: string[] = [];
  const path = "/Users/fixture/Downloads/文件.docx";
  class FixtureXhr {
    status = 200;
    responseText = JSON.stringify({ offset: 8 });
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    upload: { onprogress: ((event: { loaded: number }) => void) | null; onload: (() => void) | null } = { onprogress: null, onload: null };
    open() {}
    setRequestHeader() {}
    abort() { this.onabort?.(); }
    send(bytes: ArrayBuffer) {
      expect(bytes.byteLength).toBe(8);
      queueMicrotask(() => {
        this.upload.onprogress?.({ loaded: 4 });
        expect(progress).toContain(4);
        this.upload.onprogress?.({ loaded: 8 });
        this.upload.onload?.();
        this.onload?.();
      });
    }
  }
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, value: FixtureXhr });
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith("/api/session")) return Response.json({ actionToken: "fixture" });
    if (String(url).endsWith("/complete")) return Response.json({ fileName: "文件.docx", filePath: path, sizeBytes: 8 });
    return Response.json({ id: "xhr", offset: 0, chunkBytes: 8 });
  }) as typeof fetch;
  const result = await uploadToDownloads(new File(["abcdefgh"], "文件.docx"), {
    signal: new AbortController().signal, onProgress: (sent) => progress.push(sent), onPhase: (phase) => phases.push(phase),
  });
  expect(result.filePath).toBe(path);
  expect(progress).toContain(4);
  expect(phases).toContain("reading"); expect(phases).toContain("confirming"); expect(phases.at(-1)).toBe("saving");
});

it("finishes cancellation even when the cleanup response is stalled", async () => {
  installDocument();
  const controller = new AbortController();
  let finishCleanup: (() => void) | undefined;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/api/session")) return Response.json({ actionToken: "fixture" });
    if (init?.method === "DELETE") return new Promise<Response>((resolve) => { finishCleanup = () => resolve(Response.json({ ok: true })); });
    return Response.json({ id: "cancel", offset: 0, chunkBytes: 4 });
  }) as typeof fetch;
  const started = performance.now();
  try {
    await expect(uploadToDownloads(new File(["abcdef"], "cancel.txt"), {
      signal: controller.signal, onProgress: () => controller.abort(),
    })).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(500);
    expect(finishCleanup).toBeDefined();
  } finally { finishCleanup?.(); }
});


it("keeps the Composer attachment endpoint and original content type separate from Downloads", async () => {
  installDocument();
  const endpoint = "/tmux-dashboard/api/attachments/uploads";
  const requests: string[] = [];
  let metadata: unknown;
  globalThis.fetch = (async (url, init) => {
    const path = String(url); requests.push(path);
    if (path.endsWith("/api/session")) return Response.json({ actionToken: "fixture" });
    if (path === endpoint) { metadata = JSON.parse(String(init?.body)); return Response.json({ id: "attachment", offset: 0, chunkBytes: 8 }); }
    if (init?.method === "PUT") return Response.json({ offset: 4 });
    return Response.json({ fileName: "uuid.pdf", filePath: "/fixture/attachments/uuid.pdf", sizeBytes: 4 });
  }) as typeof fetch;
  const file = new File(["test"], "notes.pdf", { type: "application/pdf" });
  const result = await uploadFileInChunks(file, { endpoint, signal: new AbortController().signal, onProgress() {} });
  expect(metadata).toEqual({ fileName: "notes.pdf", sizeBytes: 4, contentType: "application/pdf" });
  expect(result.filePath).toBe("/fixture/attachments/uuid.pdf");
  expect(requests.filter((path) => !path.endsWith("/api/session")).every((path) => path.startsWith(endpoint))).toBe(true);
});
