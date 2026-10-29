import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface MobileApkMetadata {
  available: true;
  revision: string;
  size: number;
  sha256: string;
  modifiedAt: string;
  packageName: string;
  versionCode: number;
  versionName: string;
  downloadUrl: string;
}

/** Snapshot the build artifact before advertising it; a revision never points at the mutable build output. */
export class MobileApkStore {
  private pending: Promise<MobileApkMetadata | null> | null = null;
  constructor(private source: string, private directory: string) {}

  latest(): Promise<MobileApkMetadata | null> {
    if (this.pending) return this.pending;
    this.pending = this.snapshot().finally(() => { this.pending = null; });
    return this.pending;
  }

  async revision(revision: string): Promise<{ metadata: MobileApkMetadata; path: string } | null> {
    if (!/^[a-f0-9]{64}$/.test(revision)) return null;
    try {
      const metadata = JSON.parse(await readFile(join(this.directory, revision + ".json"), "utf8")) as MobileApkMetadata;
      const path = join(this.directory, revision + ".apk");
      const file = await lstat(path);
      if (metadata.revision !== revision || metadata.sha256 !== revision || !file.isFile() || file.size !== metadata.size) return null;
      return { metadata, path };
    } catch { return null; }
  }

  private async snapshot(): Promise<MobileApkMetadata | null> {
    const file = await lstat(this.source).catch(() => null);
    if (!file?.isFile()) return null;
    const rawManifest = await readFile(join(dirname(this.source), "output-metadata.json"), "utf8");
    const manifest = JSON.parse(rawManifest) as { applicationId?: string; elements?: Array<{ outputFile: string; versionCode: number; versionName: string }> };
    const entry = manifest.elements?.find((item) => item.outputFile === basename(this.source));
    if (manifest.applicationId !== "dev.feishu.codex.bridge" || !entry || !Number.isSafeInteger(entry.versionCode)
      || entry.versionCode < 1 || typeof entry.versionName !== "string" || !entry.versionName) {
      throw new Error("更新包缺少有效的 Android 构建元数据，请重新构建 APK。");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, randomUUID() + ".tmp");
    const digest = createHash("sha256");
    let bytes = 0;
    try {
      await pipeline(createReadStream(this.source), new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length; digest.update(chunk); callback(null, chunk);
      } }), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      const after = await lstat(this.source);
      if (file.ino !== after.ino || file.size !== bytes || file.size !== after.size || file.mtimeMs !== after.mtimeMs
        || file.ctimeMs !== after.ctimeMs || rawManifest !== await readFile(join(dirname(this.source), "output-metadata.json"), "utf8")) {
        throw new Error("APK 正在构建，请稍后重新检查更新。");
      }
      const sha256 = digest.digest("hex");
      const metadata: MobileApkMetadata = { available: true, revision: sha256, sha256, size: bytes,
        modifiedAt: file.mtime.toISOString(), packageName: manifest.applicationId, versionCode: entry.versionCode,
        versionName: entry.versionName, downloadUrl: "/api/mobile/update/download?revision=" + sha256 };
      // The same digest has the same bytes. Publish the metadata only after the copy is complete.
      const existing = await this.revision(sha256);
      if (existing) return existing.metadata;
      await rename(temporary, join(this.directory, sha256 + ".apk"));
      await writeFile(temporary, JSON.stringify(metadata), { mode: 0o600 });
      await rename(temporary, join(this.directory, sha256 + ".json"));
      return metadata;
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
