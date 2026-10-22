import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { isIP } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_URL_LENGTH = 8 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 1 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_PREVIEW_ENTRIES = 32;

const TEXT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/x-javascript",
  "image/svg+xml",
]);

const EXTENSION_MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  csv: "text/csv",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  markdown: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  text: "text/plain",
  txt: "text/plain",
  webp: "image/webp",
  xml: "application/xml",
};

const MIME_EXTENSIONS: Record<string, string> = {
  "application/json": ".json",
  "application/pdf": ".pdf",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/plain": ".txt",
};

export interface LinkToolProxySettings {
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
}

export interface LinkToolsServiceOptions {
  proxy?: LinkToolProxySettings;
  downloadsDirectory?: string;
  /** Used by tests that intentionally exercise a local fixture server. */
  allowPrivateHosts?: boolean;
  /** When false, curl will not inherit HTTP(S)_PROXY from the Bridge process. */
  useEnvironmentProxy?: boolean;
  runCurl?: LinkToolCurlRunner;
}
export interface LinkToolCurlRequest {
  url: string;
  bodyPath: string;
  headersPath: string;
  maxBytes: number;
  proxy?: string;
  useEnvironmentProxy: boolean;
}

export type LinkToolCurlRunner = (request: LinkToolCurlRequest) => Promise<void>;

export type LinkToolPreviewKind = "image" | "pdf" | "text" | "unknown";

export interface LinkToolPreviewResult {
  token: string;
  finalUrl: string;
  status: number;
  contentType: string;
  sizeBytes: number;
  fileName: string;
  kind: LinkToolPreviewKind;
  text?: string;
  textTruncated?: boolean;
}

export interface LinkToolPreviewFile {
  path: string;
  contentType: string;
  fileName: string;
  sizeBytes: number;
}

export interface LinkToolDownloadResult {
  finalUrl: string;
  status: number;
  contentType: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
}

export class LinkToolError extends Error {
  public constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "LinkToolError";
  }
}

interface PreviewEntry extends LinkToolPreviewFile {
  token: string;
  directory: string;
  expiresAt: number;
}

interface FetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  contentDisposition?: string;
  sizeBytes: number;
  bodyPath: string;
}

interface ResponseHeaders {
  status: number;
  contentType: string;
  contentDisposition?: string;
  location?: string;
}

export class LinkToolsService {
  private readonly proxy: LinkToolProxySettings;
  private readonly downloadsDirectory: string;
  private readonly allowPrivateHosts: boolean;
  private readonly useEnvironmentProxy: boolean;
  private readonly runCurlOverride?: LinkToolCurlRunner;
  private readonly previews = new Map<string, PreviewEntry>();

  public constructor(options: LinkToolsServiceOptions = {}) {
    this.proxy = options.proxy ?? {};
    this.downloadsDirectory = options.downloadsDirectory ?? join(homedir(), "Downloads");
    this.allowPrivateHosts = options.allowPrivateHosts ?? false;
    this.useEnvironmentProxy = options.useEnvironmentProxy ?? true;
    this.runCurlOverride = options.runCurl;
  }

  public async preview(rawUrl: string): Promise<LinkToolPreviewResult> {
    this.cleanupExpiredPreviews();
    const directory = await mkdtemp(join(tmpdir(), "feishu-bridge-link-preview-"));
    const bodyPath = join(directory, "body");
    try {
      const fetched = await this.fetchToFile(rawUrl, bodyPath, MAX_PREVIEW_BYTES);
      const fileName = fileNameForResponse(fetched);
      const kind = classifyPreview(fetched.contentType, fileName);
      const token = cryptoRandomToken();
      const entry: PreviewEntry = {
        token,
        directory,
        path: bodyPath,
        contentType: fetched.contentType,
        fileName,
        sizeBytes: fetched.sizeBytes,
        expiresAt: Date.now() + PREVIEW_TTL_MS,
      };
      this.previews.set(token, entry);
      await this.trimPreviewEntries();

      const textPreview = kind === "text"
        ? await readTextPreview(bodyPath, fetched.sizeBytes)
        : undefined;
      return {
        token,
        finalUrl: fetched.finalUrl,
        status: fetched.status,
        contentType: fetched.contentType,
        sizeBytes: fetched.sizeBytes,
        fileName,
        kind,
        ...(textPreview ? { text: textPreview.text, textTruncated: textPreview.truncated } : {}),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  public async getPreview(token: string): Promise<LinkToolPreviewFile | null> {
    this.cleanupExpiredPreviews();
    const entry = this.previews.get(token);
    if (!entry) return null;
    try {
      const fileStat = await stat(entry.path);
      if (!fileStat.isFile()) throw new Error("preview is not a file");
      return {
        path: entry.path,
        contentType: entry.contentType,
        fileName: entry.fileName,
        sizeBytes: fileStat.size,
      };
    } catch {
      this.previews.delete(token);
      await rm(entry.directory, { recursive: true, force: true });
      return null;
    }
  }

  public async download(rawUrl: string): Promise<LinkToolDownloadResult> {
    const directory = await mkdtemp(join(tmpdir(), "feishu-bridge-link-download-"));
    const bodyPath = join(directory, "body");
    try {
      const fetched = await this.fetchToFile(rawUrl, bodyPath, MAX_DOWNLOAD_BYTES);
      const fileName = fileNameForResponse(fetched);
      await mkdir(this.downloadsDirectory, { recursive: true });
      const filePath = await copyWithoutOverwrite(bodyPath, this.downloadsDirectory, fileName);
      return {
        finalUrl: fetched.finalUrl,
        status: fetched.status,
        contentType: fetched.contentType,
        fileName: basename(filePath),
        filePath,
        sizeBytes: fetched.sizeBytes,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  public async dispose(): Promise<void> {
    const entries = [...this.previews.values()];
    this.previews.clear();
    await Promise.all(entries.map((entry) => rm(entry.directory, { recursive: true, force: true })));
  }

  private async fetchToFile(rawUrl: string, bodyPath: string, maxBytes: number): Promise<FetchResult> {
    let currentUrl = await validateLinkToolUrl(rawUrl, this.allowPrivateHosts);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const headersPath = `${bodyPath}.headers`;
      const headers = await this.runCurl(currentUrl, bodyPath, headersPath, maxBytes);
      await unlink(headersPath).catch(() => undefined);

      if (headers.status >= 300 && headers.status < 400 && headers.location) {
        if (redirect === MAX_REDIRECTS) {
          throw new LinkToolError(502, "链接重定向次数过多。 ");
        }
        currentUrl = await validateLinkToolUrl(new URL(headers.location, currentUrl).toString(), this.allowPrivateHosts);
        continue;
      }
      if (headers.status < 200 || headers.status >= 300) {
        throw new LinkToolError(headers.status >= 400 ? 502 : 502, `目标站点返回 HTTP ${headers.status}。`);
      }
      const fileStat = await stat(bodyPath).catch(() => null);
      if (!fileStat?.isFile()) throw new LinkToolError(502, "目标站点没有返回文件内容。 ");
      if (fileStat.size > maxBytes) {
        throw new LinkToolError(413, `文件超过 ${formatBytes(maxBytes)}，无法在这里处理。`);
      }
      return {
        finalUrl: currentUrl.toString(),
        status: headers.status,
        contentType: headers.contentType,
        ...(headers.contentDisposition ? { contentDisposition: headers.contentDisposition } : {}),
        sizeBytes: fileStat.size,
        bodyPath,
      };
    }
    throw new LinkToolError(502, "链接访问失败。 ");
  }

  private async runCurl(
    url: URL,
    bodyPath: string,
    headersPath: string,
    maxBytes: number,
  ): Promise<ResponseHeaders> {
    const args = [
      "--silent",
      "--show-error",
      "--request", "GET",
      "--dump-header", headersPath,
      "--output", bodyPath,
      "--connect-timeout", "15",
      "--max-time", String(Math.ceil(REQUEST_TIMEOUT_MS / 1000)),
      "--max-filesize", String(maxBytes),
      "--proto", "=http,https",
      "--user-agent", "Feishu Codex Bridge Link Tools/1.0",
      "--compressed",
    ];
    const proxy = proxyForUrl(url, this.proxy);
    if (proxy) args.push("--proxy", proxy);
    else if (!this.useEnvironmentProxy) args.push("--proxy", "");
    args.push(url.toString());
    try {
      if (this.runCurlOverride) {
        await this.runCurlOverride({
          url: url.toString(),
          bodyPath,
          headersPath,
          maxBytes,
          ...(proxy ? { proxy } : {}),
          useEnvironmentProxy: this.useEnvironmentProxy,
        });
      } else {
        await execFileAsync("curl", args, {
          encoding: "utf8",
          maxBuffer: 64 * 1024,
          timeout: REQUEST_TIMEOUT_MS + 5_000,
        });
      }
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: string | number }).code
        : undefined;
      if (code === "ENOENT") throw new LinkToolError(503, "Mac 上找不到 curl，无法访问链接。 ");
      if (code === "ETIMEDOUT" || code === 28) throw new LinkToolError(504, "访问链接超时，请检查 VPN 或代理是否可用。 ");
      throw new LinkToolError(502, "访问链接失败，请检查链接、VPN 或代理设置。 ");
    }
    const headerText = await readFile(headersPath, "utf8").catch(() => "");
    const headers = parseResponseHeaders(headerText);
    if (!headers) throw new LinkToolError(502, "目标站点返回了无法识别的响应。 ");
    return headers;
  }

  private cleanupExpiredPreviews(): void {
    const now = Date.now();
    for (const [token, entry] of this.previews) {
      if (entry.expiresAt <= now) {
        this.previews.delete(token);
        void rm(entry.directory, { recursive: true, force: true });
      }
    }
  }

  private async trimPreviewEntries(): Promise<void> {
    if (this.previews.size <= MAX_PREVIEW_ENTRIES) return;
    const entries = [...this.previews.values()].sort((left, right) => left.expiresAt - right.expiresAt);
    await Promise.all(entries.slice(0, this.previews.size - MAX_PREVIEW_ENTRIES).map(async (entry) => {
      this.previews.delete(entry.token);
      await rm(entry.directory, { recursive: true, force: true });
    }));
  }
}

export async function validateLinkToolUrl(rawUrl: string, allowPrivateHosts = false): Promise<URL> {
  const value = rawUrl.trim();
  if (!value) throw new LinkToolError(400, "请输入链接。 ");
  if (value.length > MAX_URL_LENGTH) throw new LinkToolError(400, "链接过长。 ");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LinkToolError(400, "请输入完整的 http:// 或 https:// 链接。 ");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LinkToolError(400, "只支持 http:// 和 https:// 链接。 ");
  }
  if (url.username || url.password) {
    throw new LinkToolError(400, "链接不能包含用户名或密码。 ");
  }
  url.hash = "";
  if (!allowPrivateHosts) await assertPublicHost(url.hostname);
  return url;
}

export function classifyPreview(contentType: string, fileName: string): LinkToolPreviewKind {
  const mimeType = contentType.toLowerCase().split(";", 1)[0]!.trim();
  if (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(mimeType)) return "text";
  const extension = extname(fileName).slice(1).toLowerCase();
  if (extension === "pdf") return "pdf";
  if (extension in EXTENSION_MIME_TYPES && !extension.match(/^(avif|bmp|gif|heic|heif|jpeg|jpg|png|webp)$/)) return "text";
  return "unknown";
}

export function sanitizeLinkToolFileName(value: string): string {
  const normalized = value.normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .replace(/^\.+$/, "")
    .trim();
  if (!normalized) return "download";
  return normalized.slice(0, 180);
}

function proxyForUrl(url: URL, proxy: LinkToolProxySettings): string | undefined {
  const configured = url.protocol === "https:" ? proxy.HTTPS_PROXY ?? proxy.HTTP_PROXY : proxy.HTTP_PROXY ?? proxy.HTTPS_PROXY;
  if (!configured) return undefined;
  try {
    const parsed = new URL(configured);
    if (!["http:", "https:", "socks4:", "socks4a:", "socks5:", "socks5h:"].includes(parsed.protocol)) {
      throw new Error("unsupported proxy protocol");
    }
  } catch {
    throw new LinkToolError(500, "Bridge 的代理配置无效，请检查 HTTP_PROXY/HTTPS_PROXY。 ");
  }
  return configured;
}

function parseResponseHeaders(value: string): ResponseHeaders | null {
  const blocks = value.split(/\r?\n\r?\n/).filter((block) => /^HTTP\/\S+\s+\d{3}/m.test(block));
  const block = blocks.at(-1);
  if (!block) return null;
  const statusLine = block.split(/\r?\n/, 1)[0] ?? "";
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(statusLine)?.[1] ?? 0);
  if (!status) return null;
  const headers = new Map<string, string>();
  for (const line of block.split(/\r?\n/).slice(1)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return {
    status,
    contentType: normalizedContentType(headers.get("content-type")),
    ...(headers.get("content-disposition") ? { contentDisposition: headers.get("content-disposition") } : {}),
    ...(headers.get("location") ? { location: headers.get("location") } : {}),
  };
}

function normalizedContentType(value: string | undefined): string {
  const mimeType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mimeType || "application/octet-stream";
}

function fileNameForResponse(result: FetchResult): string {
  const fromDisposition = result.contentDisposition ? fileNameFromContentDisposition(result.contentDisposition) : undefined;
  if (fromDisposition) return sanitizeLinkToolFileName(fromDisposition);
  try {
    const pathName = decodeURIComponent(new URL(result.finalUrl).pathname);
    const name = basename(pathName);
    if (name && name !== "/" && name !== ".") return sanitizeLinkToolFileName(name);
  } catch {
    // Fall through to the generic name.
  }
  const extension = MIME_EXTENSIONS[result.contentType] ?? "";
  return sanitizeLinkToolFileName(`download${extension}`);
}

function fileNameFromContentDisposition(value: string): string | undefined {
  const encoded = /(?:^|;)\s*filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(value)?.[1];
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(value);
  const candidate = encoded ?? plain?.[1] ?? plain?.[2];
  if (!candidate) return undefined;
  try {
    return decodeURIComponent(candidate.trim().replace(/^"|"$/g, ""));
  } catch {
    return candidate.trim().replace(/^"|"$/g, "");
  }
}

async function readTextPreview(path: string, sizeBytes: number): Promise<{ text: string; truncated: boolean }> {
  const contents = await readFile(path);
  const text = contents.subarray(0, MAX_TEXT_PREVIEW_BYTES).toString("utf8");
  return { text, truncated: sizeBytes > MAX_TEXT_PREVIEW_BYTES };
}

async function copyWithoutOverwrite(sourcePath: string, directory: string, requestedName: string): Promise<string> {
  const safeName = sanitizeLinkToolFileName(requestedName);
  const extension = extname(safeName);
  const stem = extension ? safeName.slice(0, -extension.length) : safeName;
  for (let index = 0; index < 1000; index += 1) {
    const candidateName = index === 0 ? safeName : `${stem} (${index})${extension}`;
    const candidatePath = join(directory, candidateName);
    try {
      await copyFile(sourcePath, candidatePath, fsConstants.COPYFILE_EXCL);
      return candidatePath;
    } catch (error) {
      if (isFileExistsError(error)) continue;
      throw new LinkToolError(500, "无法写入 Mac 的 Downloads 目录。 ");
    }
  }
  throw new LinkToolError(500, "Downloads 目录中同名文件过多，无法生成新文件名。 ");
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}

async function assertPublicHost(hostname: string): Promise<void> {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (isBlockedHostname(normalized)) throw new LinkToolError(400, "为避免访问 Mac 内部服务，此链接的主机名不允许使用。 ");
  if (isIP(normalized) && isPrivateAddress(normalized)) {
    throw new LinkToolError(400, "为避免 SSRF，此链接不能指向本机或内网地址。 ");
  }
  if (isIP(normalized)) return;
  try {
    const addresses = await lookup(normalized, { all: true, verbatim: true });
    if (addresses.some((address) => isPrivateAddress(address.address))) {
      throw new LinkToolError(400, "为避免 SSRF，此链接不能解析到本机或内网地址。 ");
    }
  } catch (error) {
    if (error instanceof LinkToolError) throw error;
    // Let curl report DNS failures. A configured proxy may resolve the host on
    // its own, so a local DNS failure is not always decisive.
  }
}

function isBlockedHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".lan")
    || hostname === "metadata.google.internal"
    || hostname === "metadata.google.com";
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    const [first, second] = octets;
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 0)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19))
      || first >= 224;
  }
  if (isIP(normalized) === 6) {
    return normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb")
      || normalized.startsWith("::ffff:127.")
      || normalized.startsWith("::ffff:10.")
      || normalized.startsWith("::ffff:192.168.");
  }
  return false;
}

function cryptoRandomToken(): string {
  return randomUUID();
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024 * 1024))} GiB`;
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
