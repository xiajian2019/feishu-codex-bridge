import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyPreview,
  LinkToolsService,
  sanitizeLinkToolFileName,
  validateLinkToolUrl,
} from "../src/link-tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
describe("LinkToolsService", () => {
  it("fetches through the Mac-side transport, previews text, follows safe redirects, and saves without overwriting", async () => {
    const downloadsDirectory = await mkdtemp(join(tmpdir(), "bridge-link-tools-test-"));
    temporaryDirectories.push(downloadsDirectory);
    const service = new LinkToolsService({
      downloadsDirectory,
      allowPrivateHosts: true,
      useEnvironmentProxy: false,
      runCurl: async ({ url, bodyPath, headersPath }) => {
        const path = new URL(url).pathname;
        if (path === "/redirect") {
          await writeFile(headersPath, "HTTP/1.1 302 Found\r\nLocation: /text\r\n\r\n");
          await writeFile(bodyPath, "redirect body");
          return;
        }
        if (path === "/text") {
          await writeFile(
            headersPath,
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Disposition: attachment; filename=\"remote.txt\"\r\n\r\n",
          );
          await writeFile(bodyPath, "Bridge preview works.\n");
          return;
        }
        await writeFile(headersPath, "HTTP/1.1 404 Not Found\r\n\r\n");
        await writeFile(bodyPath, "missing");
      },
    });
    const baseUrl = "https://bridge.test";

    const preview = await service.preview(`${baseUrl}/redirect`);
    expect(preview).toMatchObject({
      finalUrl: `${baseUrl}/text`,
      status: 200,
      contentType: "text/plain",
      fileName: "remote.txt",
      kind: "text",
      text: "Bridge preview works.\n",
      textTruncated: false,
    });
    const previewFile = await service.getPreview(preview.token);
    expect(previewFile?.path).toBeTruthy();
    expect(await readFile(previewFile!.path, "utf8")).toBe("Bridge preview works.\n");

    const first = await service.download(`${baseUrl}/text`);
    const second = await service.download(`${baseUrl}/text`);
    expect(first.fileName).toBe("remote.txt");
    expect(second.fileName).toBe("remote (1).txt");
    expect(await readFile(first.filePath, "utf8")).toBe("Bridge preview works.\n");
    expect(await readFile(second.filePath, "utf8")).toBe("Bridge preview works.\n");

    await service.dispose();
    expect(await readFile(previewFile!.path, "utf8").catch(() => null)).toBeNull();
  });

  it("rejects unsafe URL schemes and private destinations by default", async () => {
    await expect(validateLinkToolUrl("ftp://example.com/file")).rejects.toThrow("只支持");
    await expect(validateLinkToolUrl("http://127.0.0.1:1234/file")).rejects.toThrow("不能指向");
    await expect(validateLinkToolUrl("https://example.com/path", true)).resolves.toEqual(
      expect.objectContaining({ protocol: "https:" }),
    );
  });

  it("classifies preview content and sanitizes file names", () => {
    expect(classifyPreview("image/png", "photo.png")).toBe("image");
    expect(classifyPreview("application/pdf", "report.bin")).toBe("pdf");
    expect(classifyPreview("application/octet-stream", "notes.md")).toBe("text");
    expect(sanitizeLinkToolFileName("../secret:/file?.txt")).toBe(".._secret__file_.txt");
  });
});
