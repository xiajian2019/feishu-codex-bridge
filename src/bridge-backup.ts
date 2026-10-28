import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, opendir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { StateDatabase } from "./db.js";
import { DatabaseSync, type SqliteDatabase } from "./sqlite.js";
import { resolveBridgeProjectRoot } from "./portable-runtime.js";

const BACKUP_FORMAT = "feishu-codex-bridge-backup";
const BACKUP_FORMAT_VERSION = 3;
const DATABASE_FILE = "bridge.db";
const MANIFEST_FILE = "manifest.json";
const MAX_MANIFEST_BYTES = 20 * 1024 * 1024;
const MAX_BACKUP_LIST_ENTRIES = 1_000;
const READ_CHUNK_BYTES = 64 * 1024;

export type BridgeAttachmentKind = "web" | "direct" | "aamp" | "tmux";

export interface BridgeAttachmentRoots {
  web: string[];
  direct: string[];
  aamp: string[];
  tmux: string[];
}

export interface BridgeBackupOptions {
  databasePath: string;
  outputDirectory: string;
  programVersion?: string;
  source?: "manual" | "scheduled";
  now?: () => Date;
}

export interface BridgeBackupSummary {
  scope: "sqlite";
  source: "manual" | "scheduled";
  outputDirectory: string;
  databaseBytes: number;
  /** Compatibility field: SQLite-only operations always report zero attachments. */
  attachmentCount: number;
  attachmentBytes: number;
  schemaFingerprint: string;
}

export interface BridgeBackupVerification {
  scope: "sqlite";
  source: "manual" | "scheduled";
  backupDirectory: string;
  formatVersion: number;
  programVersion: string;
  createdAt: string;
  databaseBytes: number;
  /** Compatibility field: SQLite-only operations always report zero attachments. */
  attachmentCount: number;
  attachmentBytes: number;
  attachmentCountsByKind: Record<BridgeAttachmentKind, number>;
  schemaFingerprint: string;
}

export interface BridgeBackupMetadata extends BridgeBackupVerification {
  /** Manifest metadata only; call verifyBridgeBackup before relying on artifact contents. */
  contentHashesVerified: false;
}

export type BridgeBackupListEntry =
  | { backupDirectory: string; status: "metadata"; metadata: BridgeBackupMetadata }
  | { backupDirectory: string; status: "invalid"; error: string };

export interface BridgeBackupUpgradeCheck {
  verification: BridgeBackupVerification;
  backupDirectory: string;
  sourceProgramVersion: string;
  targetProgramVersion: string;
  sourceSchemaFingerprint: string;
  migratedSchemaFingerprint: string;
  compatible: true;
}

export interface BridgeRestoreOptions {
  backupDirectory: string;
  outputDirectory: string;
}

export interface BridgeRestoreSummary {
  scope: "sqlite";
  source: "manual" | "scheduled";
  outputDirectory: string;
  databasePath: string;
  /** Compatibility field: SQLite-only operations always report zero attachments. */
  attachmentCount: number;
  attachmentBytes: number;
  schemaFingerprint: string;
  verification: BridgeBackupVerification;
}

interface BackupManifest {
  scope: "sqlite";
  source: "manual" | "scheduled";
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  createdAt: string;
  programVersion: string;
  database: {
    file: typeof DATABASE_FILE;
    sha256: string;
    bytes: number;
    schemaFingerprint: string;
  };
  attachments: [];
  checks: {
    integrity: "ok";
    foreignKeyViolations: 0;
  };
}

interface VerifiedBackup {
  root: string;
  manifest: BackupManifest;
  databasePath: string;
  verification: BridgeBackupVerification;
}

interface OutputStage {
  stage: string;
  publish(order: string[]): Promise<void>;
  cleanup(): Promise<void>;
}

const SQLITE_CONSTRUCTOR = DatabaseSync as unknown as new (
  path: string,
  options?: { readonly?: boolean; readOnly?: boolean; create?: boolean },
) => SqliteDatabase;

export function defaultBridgeAttachmentRoots(databasePath: string, bridgeDataRoot: string): BridgeAttachmentRoots {
  const databaseDirectory = dirname(resolve(databasePath));
  const dataRoot = resolve(bridgeDataRoot);
  return {
    web: [
      join(databaseDirectory, "task-attachments"),
      join(databaseDirectory, "attachments", "web"),
    ],
    direct: [
      join(dataRoot, "runtime", "direct", "attachments"),
      join(databaseDirectory, "attachments", "direct"),
    ],
    aamp: [
      join(dataRoot, "runtime", "aamp", "attachments"),
      join(databaseDirectory, "attachments", "aamp"),
    ],
    tmux: [
      join(homedir(), ".feishu-codex-bridge", "tmux-dashboard-attachments"),
      join(tmpdir(), "feishu-codex-bridge", "tmux-dashboard-attachments"),
      join(databaseDirectory, "attachments", "tmux"),
    ],
  };
}

export async function createBridgeBackup(options: BridgeBackupOptions): Promise<BridgeBackupSummary> {
  const sourceDatabase = resolve(options.databasePath);
  const destination = resolve(options.outputDirectory);
  if (sourceDatabase === destination || pathContains(destination, sourceDatabase)) {
    throw new Error("backup output must be a new directory outside the source database path");
  }
  await assertReadableDatabasePath(sourceDatabase);
  await assertDestinationInitiallyAbsent(destination);

  const output = await createOutputStage(destination);
  try {
    const stagedDatabase = join(output.stage, DATABASE_FILE);
    await vacuumInto(sourceDatabase, stagedDatabase);
    await chmod(stagedDatabase, 0o600);

    const database = openReadonlyDatabase(stagedDatabase);
    let manifest: BackupManifest;
    try {
      assertDatabaseHealthy(database, "snapshot database");
      const databaseStat = await stat(stagedDatabase);
      manifest = {
        scope: "sqlite",
        source: options.source ?? "manual",
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        createdAt: (options.now?.() ?? new Date()).toISOString(),
        programVersion: options.programVersion ?? await readBridgeProgramVersion(),
        database: {
          file: DATABASE_FILE,
          sha256: await sha256File(stagedDatabase),
          bytes: databaseStat.size,
          schemaFingerprint: schemaFingerprint(database),
        },
        attachments: [],
        checks: { integrity: "ok", foreignKeyViolations: 0 },
      };
    } finally {
      database.close();
    }

    const manifestPath = join(output.stage, MANIFEST_FILE);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(manifestPath, 0o600);
    await output.publish([DATABASE_FILE, MANIFEST_FILE]);
    return {
      scope: "sqlite",
      source: manifest.source,
      outputDirectory: destination,
      databaseBytes: manifest.database.bytes,
      attachmentCount: 0,
      attachmentBytes: 0,
      schemaFingerprint: manifest.database.schemaFingerprint,
    };
  } catch (error) {
    await output.cleanup();
    throw error;
  }
}

export async function verifyBridgeBackup(backupDirectory: string): Promise<BridgeBackupVerification> {
  return (await loadAndVerifyBackup(backupDirectory)).verification;
}

/** Reads only a bounded, validated manifest. Artifact hashes are intentionally not checked here. */
export async function inspectBridgeBackupMetadata(backupDirectory: string): Promise<BridgeBackupMetadata> {
  const root = await resolveBackupRoot(backupDirectory);
  const manifest = await readBackupManifest(root);
  return {
    scope: "sqlite",
    source: manifest.source,
    backupDirectory: root,
    formatVersion: manifest.formatVersion,
    programVersion: manifest.programVersion,
    createdAt: manifest.createdAt,
    databaseBytes: manifest.database.bytes,
    attachmentCount: 0,
    attachmentBytes: 0,
    attachmentCountsByKind: { web: 0, direct: 0, aamp: 0, tmux: 0 },
    schemaFingerprint: manifest.database.schemaFingerprint,
    contentHashesVerified: false,
  };
}

/** Lists direct child backup directories. Invalid backup manifests are returned as per-entry errors. */
export async function listBridgeBackups(parentDirectory: string): Promise<BridgeBackupListEntry[]> {
  const requestedRoot = resolve(parentDirectory);
  const parentStat = await lstat(requestedRoot).catch(() => null);
  if (!parentStat || parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("backup list path must be an existing directory and cannot be a symlink");
  }
  const parent = await realpath(requestedRoot);
  const candidates: string[] = [];
  const directory = await opendir(parent);
  let entriesSeen = 0;
  try {
    for await (const entry of directory) {
      entriesSeen += 1;
      if (entriesSeen > MAX_BACKUP_LIST_ENTRIES) {
        throw new Error(`backup list directory exceeds the ${MAX_BACKUP_LIST_ENTRIES} entry limit`);
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = join(parent, entry.name);
      if (await lstat(join(candidate, MANIFEST_FILE)).catch(() => null)) candidates.push(candidate);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  candidates.sort((left, right) => basename(left).localeCompare(basename(right), "en"));
  const result: BridgeBackupListEntry[] = [];
  for (const candidate of candidates) {
    try {
      result.push({
        backupDirectory: candidate,
        status: "metadata",
        metadata: await inspectBridgeBackupMetadata(candidate),
      });
    } catch (error) {
      result.push({
        backupDirectory: candidate,
        status: "invalid",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

/**
 * Tests whether this program's StateDatabase migrations can open a backup. All migration
 * work happens on a verified copy in a private temporary directory; the backup and live DB
 * are never opened writable.
 */
export async function checkBridgeBackupUpgradeCompatibility(
  backupDirectory: string,
): Promise<BridgeBackupUpgradeCheck> {
  const source = await loadAndVerifyBackup(backupDirectory);
  const scratch = await mkdtemp(join(tmpdir(), "bridge-backup-upgrade-check-"));
  try {
    await chmod(scratch, 0o700);
    const migratedPath = join(scratch, "migrated.db");
    await copyVerifiedArtifact(source.databasePath, migratedPath, source.manifest.database);

    const migrated = new StateDatabase(migratedPath);
    migrated.close();

    const migratedDatabase = openReadonlyDatabase(migratedPath);
    let migratedSchemaFingerprint: string;
    try {
      assertDatabaseHealthy(migratedDatabase, "migrated backup database");
      assertBridgeDatabaseIdentity(migratedDatabase, "migrated backup database");
      migratedSchemaFingerprint = schemaFingerprint(migratedDatabase);
    } finally {
      migratedDatabase.close();
    }
    return {
      verification: source.verification,
      backupDirectory: source.root,
      sourceProgramVersion: source.manifest.programVersion,
      targetProgramVersion: await readBridgeProgramVersion(),
      sourceSchemaFingerprint: source.manifest.database.schemaFingerprint,
      migratedSchemaFingerprint,
      compatible: true,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function restoreBridgeBackup(options: BridgeRestoreOptions): Promise<BridgeRestoreSummary> {
  const source = await loadAndVerifyBackup(options.backupDirectory);
  const destination = resolve(options.outputDirectory);
  if (pathContains(source.root, destination) || source.root === destination) {
    throw new Error("restore output must be a new directory outside the backup directory");
  }
  await assertDestinationInitiallyAbsent(destination);

  const output = await createOutputStage(destination);
  try {
    const stagedDatabase = join(output.stage, DATABASE_FILE);
    await copyVerifiedArtifact(source.databasePath, stagedDatabase, source.manifest.database);

    const postRestoreDatabase = openReadonlyDatabase(stagedDatabase);
    try {
      assertDatabaseHealthy(postRestoreDatabase, "restored database");
      assertBridgeDatabaseIdentity(postRestoreDatabase, "restored database");
      if (schemaFingerprint(postRestoreDatabase) !== source.manifest.database.schemaFingerprint) {
        throw new Error("restored database schema fingerprint does not match the backup");
      }
    } finally {
      postRestoreDatabase.close();
    }

    await output.publish([DATABASE_FILE]);
    return {
      scope: "sqlite",
      source: source.manifest.source,
      outputDirectory: destination,
      databasePath: join(destination, DATABASE_FILE),
      attachmentCount: 0,
      attachmentBytes: 0,
      schemaFingerprint: source.manifest.database.schemaFingerprint,
      verification: source.verification,
    };
  } catch (error) {
    await output.cleanup();
    throw error;
  }
}

async function loadAndVerifyBackup(backupDirectory: string): Promise<VerifiedBackup> {
  const root = await resolveBackupRoot(backupDirectory);
  const manifest = await readBackupManifest(root);

  const databasePath = join(root, DATABASE_FILE);
  await assertContainedRegularFile(root, databasePath, "backup database");
  const dbHash = await sha256File(databasePath);
  const dbStat = await stat(databasePath);
  if (dbHash !== manifest.database.sha256 || dbStat.size !== manifest.database.bytes) {
    throw new Error("backup database hash or size does not match the manifest");
  }

  await assertBackupArtifacts(root, manifest.formatVersion < 3);
  const database = openReadonlyDatabase(databasePath);
  try {
    assertDatabaseHealthy(database, "backup database");
    assertBridgeDatabaseIdentity(database, "backup database");
    const actualFingerprint = schemaFingerprint(database);
    if (actualFingerprint !== manifest.database.schemaFingerprint) {
      throw new Error("backup schema fingerprint does not match the manifest");
    }
  } finally {
    database.close();
  }

  return {
    root,
    manifest,
    databasePath,
    verification: {
      scope: "sqlite",
      source: manifest.source,
      backupDirectory: root,
      formatVersion: manifest.formatVersion,
      programVersion: manifest.programVersion,
      createdAt: manifest.createdAt,
      databaseBytes: manifest.database.bytes,
      attachmentCount: 0,
      attachmentBytes: 0,
      attachmentCountsByKind: { web: 0, direct: 0, aamp: 0, tmux: 0 },
      schemaFingerprint: manifest.database.schemaFingerprint,
    },
  };
}

async function resolveBackupRoot(backupDirectory: string): Promise<string> {
  const requestedRoot = resolve(backupDirectory);
  const rootStat = await lstat(requestedRoot).catch(() => null);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("backup path must be an existing directory and cannot be a symlink");
  }
  return realpath(requestedRoot);
}

async function readBackupManifest(root: string): Promise<BackupManifest> {
  const manifestPath = join(root, MANIFEST_FILE);
  await assertContainedRegularFile(root, manifestPath, "backup manifest");
  const manifestStat = await stat(manifestPath);
  if (manifestStat.size > MAX_MANIFEST_BYTES) throw new Error("backup manifest exceeds the size limit");
  const manifest = parseBackupManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  return manifest;
}

function openReadonlyDatabase(path: string, queryOnly = true): SqliteDatabase {
  const isBun = typeof (globalThis as typeof globalThis & { Bun?: unknown }).Bun !== "undefined";
  const options = isBun ? { readonly: true } : { readOnly: true };
  const database = new SQLITE_CONSTRUCTOR(path, options);
  database.exec(`${queryOnly ? "PRAGMA query_only = ON;" : ""} PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;`);
  return database;
}

async function vacuumInto(sourcePath: string, targetPath: string): Promise<void> {
  const source = openReadonlyDatabase(sourcePath, false);
  try {
    assertBridgeDatabaseIdentity(source, "source database");
    source.exec(`VACUUM INTO '${quoteSqlString(targetPath)}'`);
  } finally {
    source.close();
  }
  await assertRegularNonSymlinkFile(targetPath, "snapshot database");
}

function quoteSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function assertDatabaseHealthy(database: SqliteDatabase, label: string): void {
  const integrity = database.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
  if (integrity.length !== 1 || Object.values(integrity[0] ?? {})[0] !== "ok") {
    throw new Error(`${label} failed SQLite integrity_check`);
  }
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) throw new Error(`${label} has ${foreignKeyViolations.length} foreign-key violation(s)`);
}

function assertBridgeDatabaseIdentity(database: SqliteDatabase, label: string): void {
  const requiredColumns = [
    ["projects", "name"],
    ["projects", "path"],
    ["tasks", "task_guid"],
    ["runs", "run_id"],
    ["outbox", "task_guid"],
  ] as const;
  const missing = requiredColumns.filter(([table, column]) => !hasTable(database, table) || !hasColumn(database, table, column));
  if (missing.length > 0) {
    throw new Error(`${label} is not a Bridge database (missing ${missing.map(([table, column]) => `${table}.${column}`).join(", ")})`);
  }
}

function schemaFingerprint(database: SqliteDatabase): string {
  const objects = database.prepare(
    `SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
     FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name, tbl_name`,
  ).all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  return createHash("sha256").update(JSON.stringify(objects)).digest("hex");
}

export function parseTmuxAttachmentTags(content: string): Array<{ index: number; path: string }> {
  const tags = /<(?:image name=\[Image #\d+\]|file name="[^"\r\n]*") path="([^"\r\n]+)">/g;
  const result: Array<{ index: number; path: string }> = [];
  let index = 0;
  for (const match of content.matchAll(tags)) {
    result.push({ index, path: match[1]! });
    index += 1;
  }
  return result;
}

export function isManagedTmuxAttachmentPath(path: string): boolean {
  if (!isAbsolute(path) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,12}$/i.test(basename(path))) {
    return false;
  }
  const parent = basename(dirname(path));
  if (parent === "tmux-dashboard-attachments") {
    return basename(dirname(dirname(path))) === ".feishu-codex-bridge"
      || basename(dirname(dirname(path))) === "feishu-codex-bridge";
  }
  return parent === "tmux" && basename(dirname(dirname(path))) === "attachments";
}

async function copyStableFile(
  sourcePath: string,
  destinationPath: string,
  expectedBytes?: number,
): Promise<{ bytes: number; sha256: string }> {
  const sourceHandle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile() || before.nlink > 1n) throw new Error(`database is not a private regular file: ${sourcePath}`);
    if (expectedBytes !== undefined && before.size !== BigInt(expectedBytes)) {
      throw new Error(`database size differs from Bridge metadata: ${sourcePath}`);
    }
    const pathInfo = await lstat(sourcePath, { bigint: true });
    if (pathInfo.isSymbolicLink() || pathInfo.dev !== before.dev || pathInfo.ino !== before.ino) {
      throw new Error(`database changed while opening: ${sourcePath}`);
    }
    destinationHandle = await open(destinationPath, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    while (position < Number(before.size)) {
      const length = Math.min(buffer.length, Number(before.size) - position);
      const { bytesRead } = await sourceHandle.read(buffer, 0, length, position);
      if (bytesRead <= 0) throw new Error(`database was truncated while copying: ${sourcePath}`);
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      const { bytesWritten } = await destinationHandle.write(chunk, 0, bytesRead, position);
      if (bytesWritten !== bytesRead) throw new Error(`could not write a complete database copy: ${destinationPath}`);
      position += bytesRead;
    }
    const after = await sourceHandle.stat({ bigint: true });
    const pathAfter = await lstat(sourcePath, { bigint: true });
    if (!sameStableFile(before, after) || pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino) {
      throw new Error(`database changed while copying: ${sourcePath}`);
    }
    await destinationHandle.sync();
    await destinationHandle.close();
    destinationHandle = undefined;
    return { bytes: position, sha256: hash.digest("hex") };
  } catch (error) {
    if (destinationHandle) await destinationHandle.close().catch(() => undefined);
    await rm(destinationPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await sourceHandle.close();
  }
}

function sameStableFile(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function copyVerifiedArtifact(
  sourcePath: string,
  destinationPath: string,
  expected: { bytes: number; sha256: string },
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  const copied = await copyStableFile(sourcePath, destinationPath, expected.bytes);
  if (copied.sha256 !== expected.sha256) {
    await rm(destinationPath, { force: true });
    throw new Error(`backup artifact changed while copying: ${basename(sourcePath)}`);
  }
}

function hasTable(database: SqliteDatabase, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(database: SqliteDatabase, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function parseBackupManifest(value: unknown): BackupManifest {
  if (!isRecord(value)
    || value.format !== BACKUP_FORMAT
    || (value.formatVersion !== 1 && value.formatVersion !== 2 && value.formatVersion !== BACKUP_FORMAT_VERSION)
    || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.programVersion !== "string"
    || value.programVersion.length === 0
    || !isRecord(value.database)
    || !Array.isArray(value.attachments)
    || !isRecord(value.checks)) throw new Error("backup manifest is invalid or unsupported");
  const formatVersion = value.formatVersion as 1 | 2 | 3;
  if (formatVersion === 3 && (value.scope !== "sqlite" || value.attachments.length !== 0
    || (value.source !== "manual" && value.source !== "scheduled"))) {
    throw new Error("SQLite backup manifest must declare sqlite scope, a valid source and no attachments");
  }
  if (value.database.file !== DATABASE_FILE
    || !isSha256(value.database.sha256)
    || !Number.isSafeInteger(value.database.bytes)
    || (value.database.bytes as number) < 0
    || !isSha256(value.database.schemaFingerprint)) throw new Error("backup manifest database record is invalid");
  if (value.checks.integrity !== "ok" || value.checks.foreignKeyViolations !== 0) {
    throw new Error("backup manifest reports failed database checks");
  }
  return {
    scope: "sqlite",
    source: formatVersion === 3 && value.source === "scheduled" ? "scheduled" : "manual",
    format: BACKUP_FORMAT,
    formatVersion,
    createdAt: value.createdAt,
    programVersion: value.programVersion,
    database: {
      file: DATABASE_FILE,
      sha256: value.database.sha256,
      bytes: value.database.bytes as number,
      schemaFingerprint: value.database.schemaFingerprint,
    },
    // Legacy attachment metadata is ignored; only the database is verified and restored.
    attachments: [],
    checks: { integrity: "ok", foreignKeyViolations: 0 },
  };
}

async function assertContainedRegularFile(root: string, path: string, label: string): Promise<void> {
  if (!pathContains(root, path)) throw new Error(`${label} escapes the backup directory`);
  const parts = relative(root, path).split(sep);
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]);
    const info = await lstat(cursor).catch(() => null);
    if (!info) throw new Error(`${label} is missing`);
    if (info.isSymbolicLink()) throw new Error(`${label} cannot be a symlink`);
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error(`${label} has a non-directory parent`);
    if (index === parts.length - 1 && !info.isFile()) throw new Error(`${label} must be a regular file`);
  }
  if (!pathContains(await realpath(root), await realpath(path))) throw new Error(`${label} resolves outside the backup directory`);
}

async function assertBackupArtifacts(root: string, allowLegacyAttachments: boolean): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    // Never traverse legacy attachment directories or follow their symlinks.
    if (allowLegacyAttachments && entry.name === "attachments") continue;
    if (entry.isSymbolicLink()) throw new Error(`backup contains a symlink: ${entry.name}`);
    if (!entry.isFile() || (entry.name !== DATABASE_FILE && entry.name !== MANIFEST_FILE)) {
      throw new Error(`backup contains an unexpected artifact: ${entry.name}`);
    }
  }
}

async function sha256File(path: string): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`not a regular file: ${path}`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    while (position < Number(before.size)) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - position), position);
      if (bytesRead <= 0) throw new Error(`file changed while hashing: ${path}`);
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameStableFile(before, after)) throw new Error(`file changed while hashing: ${path}`);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function readBridgeProgramVersion(): Promise<string> {
  const projectRoot = resolveBridgeProjectRoot(import.meta.url);
  const sourceRoot = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(sourceRoot, "..", "package.json"), join(projectRoot, "package.json"), join(process.cwd(), "package.json")];
  for (const candidate of [...new Set(candidates.map((path) => resolve(path)))]) {
    try {
      const packageJson = JSON.parse(await readFile(candidate, "utf8")) as { version?: unknown };
      if (typeof packageJson.version === "string" && packageJson.version.length > 0) return packageJson.version;
    } catch {
      // Try the next known project/package root.
    }
  }
  throw new Error("could not determine Bridge program version from package.json");
}

async function createOutputStage(destination: string): Promise<OutputStage> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(dirname(destination), `.${basename(destination)}.bridge-stage-`));
  await chmod(stage, 0o700);
  let reservation: { dev: bigint; ino: bigint } | undefined;
  let published = false;
  return {
    stage,
    async publish(order: string[]): Promise<void> {
      await mkdir(destination, { mode: 0o700 });
      const created = await lstat(destination, { bigint: true });
      reservation = { dev: created.dev, ino: created.ino };
      try {
        for (const name of order) {
          const source = join(stage, name);
          if (!await lstat(source).catch(() => null)) continue;
          await assertOwnDestination(destination, reservation);
          await rename(source, join(destination, name));
        }
        await assertOwnDestination(destination, reservation);
        published = true;
      } catch (error) {
        await removeOwnedDestination(destination, reservation);
        reservation = undefined;
        throw error;
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    },
    async cleanup(): Promise<void> {
      await rm(stage, { recursive: true, force: true });
      if (!published && reservation) await removeOwnedDestination(destination, reservation);
    },
  };
}

async function assertOwnDestination(destination: string, reservation: { dev: bigint; ino: bigint }): Promise<void> {
  const current = await lstat(destination, { bigint: true }).catch(() => null);
  if (!current || !current.isDirectory() || current.dev !== reservation.dev || current.ino !== reservation.ino) {
    throw new Error("output directory changed during backup/restore publication");
  }
}

async function removeOwnedDestination(destination: string, reservation: { dev: bigint; ino: bigint } | undefined): Promise<void> {
  if (!reservation) return;
  const current = await lstat(destination, { bigint: true }).catch(() => null);
  if (current?.isDirectory() && current.dev === reservation.dev && current.ino === reservation.ino) {
    await rm(destination, { recursive: true, force: true });
  }
}

async function assertDestinationInitiallyAbsent(destination: string): Promise<void> {
  if (await lstat(destination).catch(() => null)) throw new Error(`output already exists; refusing to overwrite: ${destination}`);
}

async function assertRegularNonSymlinkFile(path: string, label: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be an existing regular file`);
}

async function assertReadableDatabasePath(path: string): Promise<void> {
  const pathInfo = await lstat(path).catch(() => null);
  if (!pathInfo || (!pathInfo.isFile() && !pathInfo.isSymbolicLink())) {
    throw new Error("source database must be an existing regular file or a symlink to one");
  }
  const canonical = await realpath(path).catch(() => null);
  if (!canonical) throw new Error("source database target does not exist");
  const targetInfo = await stat(canonical);
  if (!targetInfo.isFile()) throw new Error("source database symlink must resolve to a regular file");
}

function pathContains(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
