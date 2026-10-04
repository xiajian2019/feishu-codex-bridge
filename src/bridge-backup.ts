import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { DatabaseSync, type SqliteDatabase } from "./sqlite.js";
import { resolveBridgeProjectRoot } from "./portable-runtime.js";

const BACKUP_FORMAT = "feishu-codex-bridge-backup";
const BACKUP_FORMAT_VERSION = 1;
const DATABASE_FILE = "bridge.db";
const MANIFEST_FILE = "manifest.json";
const MAX_MANIFEST_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENT_FILES = 10_000;
const MAX_ATTACHMENT_BYTES = 250 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export type BridgeAttachmentKind = "web" | "direct" | "aamp";

export interface BridgeAttachmentRoots {
  web: string[];
  direct: string[];
  aamp: string[];
}

export interface BridgeBackupOptions {
  databasePath: string;
  outputDirectory: string;
  attachmentRoots: BridgeAttachmentRoots;
  programVersion?: string;
}

export interface BridgeBackupSummary {
  outputDirectory: string;
  databaseBytes: number;
  attachmentCount: number;
  attachmentBytes: number;
  schemaFingerprint: string;
}

export interface BridgeBackupVerification {
  backupDirectory: string;
  programVersion: string;
  createdAt: string;
  databaseBytes: number;
  attachmentCount: number;
  attachmentBytes: number;
  schemaFingerprint: string;
}

export interface BridgeRestoreOptions {
  backupDirectory: string;
  outputDirectory: string;
}

export interface BridgeRestoreSummary {
  outputDirectory: string;
  databasePath: string;
  attachmentCount: number;
  attachmentBytes: number;
  schemaFingerprint: string;
}

interface AttachmentReference {
  kind: BridgeAttachmentKind;
  key: string;
  index?: number;
  sourcePath: string;
  expectedBytes?: number;
}

interface ManifestReference {
  kind: BridgeAttachmentKind;
  key: string;
  index?: number;
}

interface ManifestAttachment {
  id: string;
  kind: BridgeAttachmentKind;
  file: string;
  sha256: string;
  bytes: number;
  references: ManifestReference[];
}

interface BackupManifest {
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
  attachments: ManifestAttachment[];
  checks: {
    integrity: "ok";
    foreignKeyViolations: 0;
  };
}

interface VerifiedBackup {
  root: string;
  manifest: BackupManifest;
  databasePath: string;
  entries: Map<string, string>;
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
      const references = collectAttachmentReferences(database);
      if (references.length > MAX_ATTACHMENT_FILES) {
        throw new Error(`backup has too many attachment references (limit ${MAX_ATTACHMENT_FILES})`);
      }
      const attachments = await copyReferencedAttachments(
        references,
        normalizeAttachmentRoots(options.attachmentRoots),
        output.stage,
      );
      const databaseStat = await stat(stagedDatabase);
      manifest = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        createdAt: new Date().toISOString(),
        programVersion: options.programVersion ?? await readBridgeProgramVersion(),
        database: {
          file: DATABASE_FILE,
          sha256: await sha256File(stagedDatabase),
          bytes: databaseStat.size,
          schemaFingerprint: schemaFingerprint(database),
        },
        attachments,
        checks: { integrity: "ok", foreignKeyViolations: 0 },
      };
    } finally {
      database.close();
    }

    const manifestPath = join(output.stage, MANIFEST_FILE);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(manifestPath, 0o600);
    await output.publish(["attachments", DATABASE_FILE, MANIFEST_FILE]);
    return {
      outputDirectory: destination,
      databaseBytes: manifest.database.bytes,
      attachmentCount: manifest.attachments.length,
      attachmentBytes: manifest.attachments.reduce((total, attachment) => total + attachment.bytes, 0),
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
    await copyVerifiedArtifact(source.databasePath, stagedDatabase, source.manifest.database, Number.MAX_SAFE_INTEGER);

    const rewrittenPaths = new Map<string, string>();
    let attachmentBytes = 0;
    for (const attachment of source.manifest.attachments) {
      const sourcePath = source.entries.get(attachment.file);
      if (!sourcePath) throw new Error(`backup manifest is missing ${attachment.file}`);
      const stagedAttachmentPath = join(output.stage, ...validateArtifactPath(attachment.file));
      await copyVerifiedArtifact(sourcePath, stagedAttachmentPath, attachment);
      const finalAttachmentPath = join(destination, ...validateArtifactPath(attachment.file));
      for (const reference of attachment.references) {
        const identity = manifestReferenceIdentity(reference);
        if (rewrittenPaths.has(identity)) throw new Error("backup manifest repeats an attachment reference");
        rewrittenPaths.set(identity, finalAttachmentPath);
      }
      attachmentBytes += attachment.bytes;
    }

    rewriteRestoredAttachmentPaths(stagedDatabase, rewrittenPaths, source.manifest.database.schemaFingerprint);
    const postRestoreDatabase = openReadonlyDatabase(stagedDatabase);
    try {
      assertDatabaseHealthy(postRestoreDatabase, "restored database");
      assertBridgeDatabaseIdentity(postRestoreDatabase, "restored database");
      if (schemaFingerprint(postRestoreDatabase) !== source.manifest.database.schemaFingerprint) {
        throw new Error("restored database schema fingerprint changed during path relocation");
      }
      assertRestoredAttachmentPaths(postRestoreDatabase, destination, source.manifest.attachments);
    } finally {
      postRestoreDatabase.close();
    }

    await output.publish(["attachments", DATABASE_FILE]);
    return {
      outputDirectory: destination,
      databasePath: join(destination, DATABASE_FILE),
      attachmentCount: source.manifest.attachments.length,
      attachmentBytes,
      schemaFingerprint: source.manifest.database.schemaFingerprint,
    };
  } catch (error) {
    await output.cleanup();
    throw error;
  }
}

async function loadAndVerifyBackup(backupDirectory: string): Promise<VerifiedBackup> {
  const requestedRoot = resolve(backupDirectory);
  const rootStat = await lstat(requestedRoot).catch(() => null);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("backup path must be an existing directory and cannot be a symlink");
  }
  const root = await realpath(requestedRoot);
  const manifestPath = join(root, MANIFEST_FILE);
  await assertContainedRegularFile(root, manifestPath, "backup manifest");
  const manifestStat = await stat(manifestPath);
  if (manifestStat.size > MAX_MANIFEST_BYTES) throw new Error("backup manifest exceeds the size limit");
  const manifest = parseBackupManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);

  const databasePath = join(root, DATABASE_FILE);
  await assertContainedRegularFile(root, databasePath, "backup database");
  const dbHash = await sha256File(databasePath);
  const dbStat = await stat(databasePath);
  if (dbHash !== manifest.database.sha256 || dbStat.size !== manifest.database.bytes) {
    throw new Error("backup database hash or size does not match the manifest");
  }

  const entries = new Map<string, string>([[DATABASE_FILE, databasePath]]);
  const expectedFiles = new Set([DATABASE_FILE, MANIFEST_FILE]);
  let attachmentBytes = 0;
  for (const attachment of manifest.attachments) {
    validateManifestAttachment(attachment);
    if (entries.has(attachment.file) || expectedFiles.has(attachment.file)) {
      throw new Error(`backup manifest repeats artifact path: ${attachment.file}`);
    }
    const attachmentPath = join(root, ...validateArtifactPath(attachment.file));
    await assertContainedRegularFile(root, attachmentPath, "backup attachment");
    const actualStat = await stat(attachmentPath);
    const actualHash = await sha256File(attachmentPath);
    if (actualStat.size !== attachment.bytes || actualHash !== attachment.sha256) {
      throw new Error(`backup attachment does not match manifest: ${attachment.file}`);
    }
    entries.set(attachment.file, attachmentPath);
    expectedFiles.add(attachment.file);
    attachmentBytes += attachment.bytes;
  }

  await assertDirectoryContainsOnlyArtifacts(root, expectedFiles);
  const database = openReadonlyDatabase(databasePath);
  try {
    assertDatabaseHealthy(database, "backup database");
    assertBridgeDatabaseIdentity(database, "backup database");
    const actualFingerprint = schemaFingerprint(database);
    if (actualFingerprint !== manifest.database.schemaFingerprint) {
      throw new Error("backup schema fingerprint does not match the manifest");
    }
    assertManifestReferencesMatchDatabase(database, manifest.attachments);
  } finally {
    database.close();
  }

  return {
    root,
    manifest,
    databasePath,
    entries,
    verification: {
      backupDirectory: root,
      programVersion: manifest.programVersion,
      createdAt: manifest.createdAt,
      databaseBytes: manifest.database.bytes,
      attachmentCount: manifest.attachments.length,
      attachmentBytes,
      schemaFingerprint: manifest.database.schemaFingerprint,
    },
  };
}

function openReadonlyDatabase(path: string, queryOnly = true): SqliteDatabase {
  const isBun = typeof (globalThis as typeof globalThis & { Bun?: unknown }).Bun !== "undefined";
  const options = isBun ? { readonly: true } : { readOnly: true };
  const database = new SQLITE_CONSTRUCTOR(path, options);
  database.exec(`${queryOnly ? "PRAGMA query_only = ON;" : ""} PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;`);
  return database;
}

function openWritableDatabase(path: string): SqliteDatabase {
  const database = new SQLITE_CONSTRUCTOR(path);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;");
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

function collectAttachmentReferences(database: SqliteDatabase): AttachmentReference[] {
  const result: AttachmentReference[] = [];
  if (hasTable(database, "web_task_attachments") && hasColumn(database, "web_task_attachments", "local_path")) {
    const rows = database.prepare(
      "SELECT attachment_id, local_path, size_bytes FROM web_task_attachments WHERE local_path IS NOT NULL ORDER BY attachment_id",
    ).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      result.push({
        kind: "web",
        key: requireReferenceKey(row.attachment_id, "web attachment id"),
        sourcePath: requireReferencePath(row.local_path, "web attachment path"),
        expectedBytes: requireOptionalByteCount(row.size_bytes, "web attachment size"),
      });
    }
  }

  if (hasTable(database, "bridge_task_attachments") && hasColumn(database, "bridge_task_attachments", "local_path")) {
    const rows = database.prepare(
      "SELECT attachment_id, local_path FROM bridge_task_attachments WHERE local_path IS NOT NULL ORDER BY attachment_id",
    ).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      result.push({
        kind: "direct",
        key: requireReferenceKey(row.attachment_id, "Direct attachment id"),
        sourcePath: requireReferencePath(row.local_path, "Direct attachment path"),
      });
    }
  }

  if (hasTable(database, "aamp_tasks") && hasColumn(database, "aamp_tasks", "image_local_paths")) {
    const rows = database.prepare(
      "SELECT aamp_task_id, image_local_paths FROM aamp_tasks ORDER BY aamp_task_id",
    ).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const taskId = requireReferenceKey(row.aamp_task_id, "AAMP task id");
      const paths = parseStringArray(row.image_local_paths, `AAMP attachment list for task ${taskId}`);
      paths.forEach((pathValue, index) => {
        result.push({
          kind: "aamp",
          key: taskId,
          index,
          sourcePath: requireReferencePath(pathValue, `AAMP attachment path for task ${taskId}`),
        });
      });
    }
  }
  return result;
}

async function copyReferencedAttachments(
  references: AttachmentReference[],
  roots: BridgeAttachmentRoots,
  stageDirectory: string,
): Promise<ManifestAttachment[]> {
  const grouped = new Map<string, { kind: BridgeAttachmentKind; sourcePath: string; references: AttachmentReference[]; expectedBytes?: number }>();
  for (const reference of references) {
    const sourcePath = await resolveOwnedAttachmentPath(reference.sourcePath, reference.kind, roots);
    const identity = `${reference.kind}\0${sourcePath}`;
    const group = grouped.get(identity) ?? {
      kind: reference.kind,
      sourcePath,
      references: [],
      ...(reference.expectedBytes === undefined ? {} : { expectedBytes: reference.expectedBytes }),
    };
    if (reference.expectedBytes !== undefined && group.expectedBytes !== undefined
      && reference.expectedBytes !== group.expectedBytes) {
      throw new Error(`attachment metadata disagrees for ${reference.sourcePath}`);
    }
    group.references.push(reference);
    grouped.set(identity, group);
  }
  if (grouped.size > MAX_ATTACHMENT_FILES) throw new Error(`backup has too many files (limit ${MAX_ATTACHMENT_FILES})`);

  const manifest: ManifestAttachment[] = [];
  let totalBytes = 0;
  for (const group of grouped.values()) {
    const attachmentId = randomUUID();
    const file = `attachments/${group.kind}/${attachmentId}${safeExtension(group.sourcePath)}`;
    const targetPath = join(stageDirectory, ...validateArtifactPath(file));
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    const copied = await copyStableFile(group.sourcePath, targetPath, group.expectedBytes);
    totalBytes += copied.bytes;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(`attachments exceed the total backup limit (${MAX_TOTAL_ATTACHMENT_BYTES} bytes)`);
    }
    manifest.push({
      id: attachmentId,
      kind: group.kind,
      file,
      sha256: copied.sha256,
      bytes: copied.bytes,
      references: group.references.map(({ kind, key, index }) => ({ kind, key, ...(index === undefined ? {} : { index }) })),
    });
  }
  return manifest.sort((left, right) => left.file.localeCompare(right.file));
}

async function resolveOwnedAttachmentPath(
  inputPath: string,
  kind: BridgeAttachmentKind,
  roots: BridgeAttachmentRoots,
): Promise<string> {
  if (!isAbsolute(inputPath)) {
    throw new Error(`${kind} attachment path must be absolute: ${inputPath}`);
  }
  const absolutePath = resolve(inputPath);
  const matchingRoots = roots[kind].filter((root) => pathContains(resolve(root), absolutePath));
  if (matchingRoots.length === 0) {
    throw new Error(`${kind} attachment is outside Bridge-owned attachment directories: ${inputPath}`);
  }
  const rootAbsolute = resolve(matchingRoots.sort((left, right) => resolve(right).length - resolve(left).length)[0]);
  const rootReal = await realpath(rootAbsolute).catch(() => null);
  if (!rootReal) throw new Error(`${kind} attachment directory is missing: ${rootAbsolute}`);
  const relativePath = relative(rootAbsolute, absolutePath);
  if (!relativePath || relativePath.split(sep).some((part) => part === ".." || part === "")) {
    throw new Error(`${kind} attachment does not name a file under its attachment directory: ${inputPath}`);
  }
  let cursor = rootAbsolute;
  const parts = relativePath.split(sep);
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]);
    const info = await lstat(cursor).catch(() => null);
    if (!info) throw new Error(`${kind} attachment is missing: ${inputPath}`);
    if (info.isSymbolicLink()) throw new Error(`${kind} attachment path contains a symlink: ${inputPath}`);
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error(`${kind} attachment parent is not a directory: ${inputPath}`);
    if (index === parts.length - 1 && !info.isFile()) throw new Error(`${kind} attachment is not a regular file: ${inputPath}`);
  }
  const realFile = await realpath(absolutePath);
  if (!pathContains(rootReal, realFile)) throw new Error(`${kind} attachment resolves outside its Bridge-owned directory: ${inputPath}`);
  return absolutePath;
}

async function copyStableFile(
  sourcePath: string,
  destinationPath: string,
  expectedBytes?: number,
  maxBytes = MAX_ATTACHMENT_BYTES,
): Promise<{ bytes: number; sha256: string }> {
  const sourceHandle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile() || before.nlink > 1n) throw new Error(`attachment is not a private regular file: ${sourcePath}`);
    if (before.size > BigInt(maxBytes)) throw new Error(`attachment exceeds the per-file limit: ${sourcePath}`);
    if (expectedBytes !== undefined && before.size !== BigInt(expectedBytes)) {
      throw new Error(`attachment size differs from Bridge metadata: ${sourcePath}`);
    }
    const pathInfo = await lstat(sourcePath, { bigint: true });
    if (pathInfo.isSymbolicLink() || pathInfo.dev !== before.dev || pathInfo.ino !== before.ino) {
      throw new Error(`attachment changed while opening: ${sourcePath}`);
    }
    destinationHandle = await open(destinationPath, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    while (position < Number(before.size)) {
      const length = Math.min(buffer.length, Number(before.size) - position);
      const { bytesRead } = await sourceHandle.read(buffer, 0, length, position);
      if (bytesRead <= 0) throw new Error(`attachment was truncated while copying: ${sourcePath}`);
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      const { bytesWritten } = await destinationHandle.write(chunk, 0, bytesRead, position);
      if (bytesWritten !== bytesRead) throw new Error(`could not write a complete attachment copy: ${destinationPath}`);
      position += bytesRead;
    }
    const after = await sourceHandle.stat({ bigint: true });
    const pathAfter = await lstat(sourcePath, { bigint: true });
    if (!sameStableFile(before, after) || pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino) {
      throw new Error(`attachment changed while copying: ${sourcePath}`);
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
  maxBytes = MAX_ATTACHMENT_BYTES,
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  const copied = await copyStableFile(sourcePath, destinationPath, expected.bytes, maxBytes);
  if (copied.sha256 !== expected.sha256) {
    await rm(destinationPath, { force: true });
    throw new Error(`backup artifact changed while copying: ${basename(sourcePath)}`);
  }
}

function rewriteRestoredAttachmentPaths(databasePath: string, rewrittenPaths: Map<string, string>, expectedSchemaFingerprint: string): void {
  const database = openWritableDatabase(databasePath);
  try {
    if (schemaFingerprint(database) !== expectedSchemaFingerprint) throw new Error("backup schema changed before restore path relocation");
    database.exec("BEGIN IMMEDIATE");
    try {
      const remaining = new Map(rewrittenPaths);
      for (const [table, keyColumn, kind] of [
        ["web_task_attachments", "attachment_id", "web"],
        ["bridge_task_attachments", "attachment_id", "direct"],
      ] as const) {
        if (!hasTable(database, table) || !hasColumn(database, table, "local_path")) continue;
        const rows = database.prepare(`SELECT ${keyColumn}, local_path FROM ${table} WHERE local_path IS NOT NULL`).all() as Array<Record<string, unknown>>;
        const update = database.prepare(`UPDATE ${table} SET local_path = ? WHERE ${keyColumn} = ?`);
        for (const row of rows) {
          const key = requireReferenceKey(row[keyColumn], `${kind} attachment id`);
          const identity = manifestReferenceIdentity({ kind, key });
          const relocated = remaining.get(identity);
          if (!relocated) throw new Error(`backup manifest omits ${kind} attachment ${key}`);
          update.run(relocated, key);
          remaining.delete(identity);
        }
      }

      if (hasTable(database, "aamp_tasks") && hasColumn(database, "aamp_tasks", "image_local_paths")) {
        const rows = database.prepare("SELECT aamp_task_id, image_local_paths FROM aamp_tasks").all() as Array<Record<string, unknown>>;
        const update = database.prepare("UPDATE aamp_tasks SET image_local_paths = ? WHERE aamp_task_id = ?");
        for (const row of rows) {
          const key = requireReferenceKey(row.aamp_task_id, "AAMP task id");
          const paths = parseStringArray(row.image_local_paths, `AAMP attachment list for task ${key}`);
          let changed = false;
          for (let index = 0; index < paths.length; index += 1) {
            const identity = manifestReferenceIdentity({ kind: "aamp", key, index });
            const relocated = remaining.get(identity);
            if (relocated) {
              paths[index] = relocated;
              remaining.delete(identity);
              changed = true;
            }
          }
          if (changed) update.run(JSON.stringify(paths), key);
        }
      }
      if (remaining.size > 0) throw new Error("backup manifest contains attachment references absent from its database");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function assertRestoredAttachmentPaths(database: SqliteDatabase, destination: string, attachments: ManifestAttachment[]): void {
  const expected = new Map<string, string>();
  for (const attachment of attachments) {
    const filePath = join(destination, ...validateArtifactPath(attachment.file));
    for (const reference of attachment.references) expected.set(manifestReferenceIdentity(reference), filePath);
  }
  const actualReferences = collectAttachmentReferences(database);
  if (actualReferences.length !== expected.size) throw new Error("restored database attachment references do not match the backup manifest");
  for (const reference of actualReferences) {
    const identity = manifestReferenceIdentity(reference);
    const expectedPath = expected.get(identity);
    if (!expectedPath || resolve(reference.sourcePath) !== resolve(expectedPath)) {
      throw new Error(`restored ${reference.kind} attachment still points outside the new directory`);
    }
    expected.delete(identity);
  }
  if (expected.size > 0) throw new Error("restored database is missing attachment path rewrites");
}

function assertManifestReferencesMatchDatabase(database: SqliteDatabase, attachments: ManifestAttachment[]): void {
  const expected = new Set<string>();
  for (const attachment of attachments) {
    for (const reference of attachment.references) {
      if (reference.kind !== attachment.kind) throw new Error("backup attachment kind does not match its reference");
      const identity = manifestReferenceIdentity(reference);
      if (expected.has(identity)) throw new Error("backup manifest repeats an attachment reference");
      expected.add(identity);
    }
  }
  const actual = collectAttachmentReferences(database);
  if (actual.length !== expected.size) throw new Error("backup manifest does not describe every database attachment reference");
  for (const reference of actual) {
    if (!expected.delete(manifestReferenceIdentity(reference))) throw new Error("backup manifest does not match database attachment references");
  }
  if (expected.size > 0) throw new Error("backup manifest contains unknown attachment references");
}

function manifestReferenceIdentity(reference: ManifestReference): string {
  return reference.kind === "aamp"
    ? `aamp\0${reference.key}\0${reference.index}`
    : `${reference.kind}\0${reference.key}`;
}

function hasTable(database: SqliteDatabase, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(database: SqliteDatabase, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function parseStringArray(value: unknown, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error(`${label} is invalid`);
  return parsed;
}

function requireReferenceKey(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new Error(`${label} is invalid`);
  return value;
}

function requireReferencePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32_768) throw new Error(`${label} is invalid`);
  return value;
}

function requireOptionalByteCount(value: unknown, label: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function normalizeAttachmentRoots(roots: BridgeAttachmentRoots): BridgeAttachmentRoots {
  return {
    web: roots.web.map((root) => resolve(root)),
    direct: roots.direct.map((root) => resolve(root)),
    aamp: roots.aamp.map((root) => resolve(root)),
  };
}

function safeExtension(path: string): string {
  const extension = extname(path).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
}

function validateArtifactPath(value: string): string[] {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\\") || value.includes("\0")
    || isAbsolute(value) || win32.isAbsolute(value)) throw new Error("backup manifest contains an invalid artifact path");
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("backup manifest artifact path escapes its directory");
  }
  return parts;
}

function parseBackupManifest(value: unknown): BackupManifest {
  if (!isRecord(value)
    || value.format !== BACKUP_FORMAT
    || value.formatVersion !== BACKUP_FORMAT_VERSION
    || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.programVersion !== "string"
    || value.programVersion.length === 0
    || !isRecord(value.database)
    || !Array.isArray(value.attachments)
    || !isRecord(value.checks)) throw new Error("backup manifest is invalid or unsupported");
  if (value.database.file !== DATABASE_FILE
    || !isSha256(value.database.sha256)
    || !Number.isSafeInteger(value.database.bytes)
    || (value.database.bytes as number) < 0
    || !isSha256(value.database.schemaFingerprint)) throw new Error("backup manifest database record is invalid");
  if (value.checks.integrity !== "ok" || value.checks.foreignKeyViolations !== 0) {
    throw new Error("backup manifest reports failed database checks");
  }
  if (value.attachments.length > MAX_ATTACHMENT_FILES) throw new Error("backup manifest contains too many attachments");
  const attachments = value.attachments.map((raw): ManifestAttachment => {
    if (!isRecord(raw)
      || typeof raw.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.id)
      || (raw.kind !== "web" && raw.kind !== "direct" && raw.kind !== "aamp")
      || typeof raw.file !== "string"
      || !isSha256(raw.sha256)
      || !Number.isSafeInteger(raw.bytes)
      || (raw.bytes as number) < 0
      || (raw.bytes as number) > MAX_ATTACHMENT_BYTES
      || !Array.isArray(raw.references)) throw new Error("backup manifest contains an invalid attachment record");
    const references = raw.references.map((reference): ManifestReference => {
      if (!isRecord(reference)
        || (reference.kind !== "web" && reference.kind !== "direct" && reference.kind !== "aamp")
        || typeof reference.key !== "string"
        || reference.key.length === 0
        || reference.key.length > 512) throw new Error("backup manifest contains an invalid attachment reference");
      if (reference.kind === "aamp") {
        if (!Number.isSafeInteger(reference.index) || (reference.index as number) < 0) {
          throw new Error("backup manifest contains an invalid AAMP attachment index");
        }
        return { kind: "aamp", key: reference.key, index: reference.index as number };
      }
      if (reference.index !== undefined) throw new Error("backup manifest contains an unexpected attachment index");
      return { kind: reference.kind, key: reference.key };
    });
    return { id: raw.id, kind: raw.kind, file: raw.file, sha256: raw.sha256, bytes: raw.bytes as number, references };
  });
  const attachmentBytes = attachments.reduce((sum, attachment) => sum + attachment.bytes, 0);
  if (attachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("backup manifest exceeds total attachment size limit");
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: value.createdAt,
    programVersion: value.programVersion,
    database: {
      file: DATABASE_FILE,
      sha256: value.database.sha256,
      bytes: value.database.bytes as number,
      schemaFingerprint: value.database.schemaFingerprint,
    },
    attachments,
    checks: { integrity: "ok", foreignKeyViolations: 0 },
  };
}

function validateManifestAttachment(attachment: ManifestAttachment): void {
  const parts = validateArtifactPath(attachment.file);
  if (parts.length !== 3 || parts[0] !== "attachments" || parts[1] !== attachment.kind
    || !parts[2].startsWith(attachment.id)) throw new Error("backup manifest attachment path does not match its record");
  if (attachment.references.length === 0) throw new Error("backup manifest contains an unreferenced attachment file");
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

async function assertDirectoryContainsOnlyArtifacts(root: string, expectedFiles: Set<string>): Promise<void> {
  const actualFiles = new Set<string>();
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(directory, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) throw new Error(`backup contains a symlink: ${relativePath}`);
      if (info.isDirectory()) {
        if (relativePath !== "attachments" && !relativePath.startsWith("attachments/")) {
          throw new Error(`backup contains an unexpected directory: ${relativePath}`);
        }
        await visit(fullPath, relativePath);
      } else if (info.isFile()) {
        actualFiles.add(relativePath);
      } else {
        throw new Error(`backup contains a non-regular artifact: ${relativePath}`);
      }
    }
  }
  await visit(root, "");
  if (actualFiles.size !== expectedFiles.size || [...expectedFiles].some((file) => !actualFiles.has(file))) {
    throw new Error("backup contains missing or unexpected files");
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
