import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "../src/db.js";
import {
  createBridgeBackup,
  defaultBridgeAttachmentRoots,
  restoreBridgeBackup,
  verifyBridgeBackup,
} from "../src/bridge-backup.js";
import { DatabaseSync } from "../src/sqlite.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Bridge backup", () => {
  it("rejects modified attachments before creating any restored output", async () => {
    const fixture = await makeSimpleBackup();
    const manifest = JSON.parse(readFileSync(join(fixture.backupDirectory, "manifest.json"), "utf8"));
    writeFileSync(join(fixture.backupDirectory, manifest.attachments[0].file), "two");
    await expect(verifyBridgeBackup(fixture.backupDirectory)).rejects.toThrow("does not match manifest");
    const outputDirectory = join(fixture.root, "restore-tampered");
    await expect(restoreBridgeBackup({ backupDirectory: fixture.backupDirectory, outputDirectory })).rejects.toThrow("does not match manifest");
    expect(existsSync(outputDirectory)).toBe(false);
  });

  it("snapshots an open WAL database and relocates Web, Direct, and AAMP attachments", async () => {
    const root = makeTemporaryDirectory();
    const databaseDirectory = join(root, "data");
    const dataRoot = join(root, "portable");
    mkdirSync(databaseDirectory, { recursive: true });
    const realDatabasePath = join(databaseDirectory, "bridge-data.db");
    const databasePath = join(databaseDirectory, "bridge.db");
    symlinkSync(realDatabasePath, databasePath);

    const roots = defaultBridgeAttachmentRoots(databasePath, dataRoot);
    const webPath = join(roots.web[0], "web.txt");
    const directPath = join(roots.direct[0], "task-1", "direct.png");
    const aampPath = join(roots.aamp[0], "aamp.png");
    mkdirSync(roots.web[0], { recursive: true });
    mkdirSync(join(roots.direct[0], "task-1"), { recursive: true });
    mkdirSync(roots.aamp[0], { recursive: true });
    writeFileSync(webPath, "web attachment\n");
    writeFileSync(directPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
    writeFileSync(aampPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6]));

    const database = new StateDatabase(databasePath);
    database.createStagedWebTaskAttachment({
      attachmentId: "web-attachment-1",
      fileName: "web.txt",
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength("web attachment\n"),
      localPath: webPath,
    });
    const directTask = database.ingestDirectMessage({
      sourceEventId: "evt-backup",
      eventType: "im.message.receive_v1",
      messageId: "msg-backup",
      chatId: "chat-backup",
      chatType: "p2p",
      senderId: "sender-backup",
      text: "请处理图片",
      sessionKey: "chat:backup",
      attachments: [{ type: "image", fileKey: "file-key", fileName: "direct.png" }],
    }).task;
    const directAttachment = database.getBridgeTaskAttachments(directTask.bridge_task_id)[0];
    database.markAttachmentDownloaded(directAttachment.attachment_id, directPath);
    database.initializeAampTask({
      aampTaskId: "aamp-backup",
      chatId: "chat-aamp",
      imageLocalPaths: [aampPath],
    });

    const walWriter = new DatabaseSync(databasePath);
    walWriter.exec("CREATE TABLE web_idempotency_snapshot_probe (request_key TEXT PRIMARY KEY, result TEXT NOT NULL)");
    walWriter.prepare("INSERT INTO web_idempotency_snapshot_probe VALUES (?, ?)").run("key-1", "saved-in-wal");
    expect(existsSync(`${realDatabasePath}-wal`)).toBe(true);

    const backupDirectory = join(root, "backup");
    const backup = await createBridgeBackup({
      databasePath,
      outputDirectory: backupDirectory,
      attachmentRoots: roots,
      programVersion: "test-version",
    });
    expect(backup.attachmentCount).toBe(3);
    expect(lstatSync(databasePath).isSymbolicLink()).toBe(true);
    expect(database.getStagedWebTaskAttachment("web-attachment-1")?.local_path).toBe(webPath);
    expect(walWriter.prepare("SELECT result FROM web_idempotency_snapshot_probe WHERE request_key = ?").get("key-1"))
      .toEqual({ result: "saved-in-wal" });

    const verification = await verifyBridgeBackup(backupDirectory);
    expect(verification).toMatchObject({
      programVersion: "test-version",
      attachmentCount: 3,
      schemaFingerprint: backup.schemaFingerprint,
    });
    expect(lstatSync(backupDirectory).mode & 0o777).toBe(0o700);

    const restoreDirectory = join(root, "restored");
    const restored = await restoreBridgeBackup({ backupDirectory, outputDirectory: restoreDirectory });
    expect(restored.databasePath).toBe(join(restoreDirectory, "bridge.db"));
    const restoredProbe = new DatabaseSync(restored.databasePath);
    try {
      expect(restoredProbe.prepare("SELECT result FROM web_idempotency_snapshot_probe WHERE request_key = ?").get("key-1"))
        .toEqual({ result: "saved-in-wal" });
    } finally {
      restoredProbe.close();
    }
    const restoredDatabase = new StateDatabase(restored.databasePath);
    try {
      const restoredWebPath = restoredDatabase.getStagedWebTaskAttachment("web-attachment-1")?.local_path;
      const restoredDirectPath = restoredDatabase.getBridgeTaskAttachments(directTask.bridge_task_id)[0]?.local_path;
      const restoredAampPath = restoredDatabase.listAampTasks({ search: "aamp-backup" }).items[0]?.image_local_paths[0];
      for (const path of [restoredWebPath, restoredDirectPath, restoredAampPath]) {
        expect(path).toStartWith(restoreDirectory);
        expect(existsSync(path!)).toBe(true);
      }
      expect(restoredWebPath).not.toBe(webPath);
      expect(restoredDirectPath).not.toBe(directPath);
      expect(restoredAampPath).not.toBe(aampPath);
      expect(restoredDatabase.listAampTasks({ search: "aamp-backup" }).items[0]?.image_local_paths).toHaveLength(1);
    } finally {
      restoredDatabase.close();
    }

    const secondBackup = join(root, "rebackup");
    await createBridgeBackup({
      databasePath: restored.databasePath,
      outputDirectory: secondBackup,
      attachmentRoots: defaultBridgeAttachmentRoots(restored.databasePath, dataRoot),
      programVersion: "test-version",
    });
    expect((await verifyBridgeBackup(secondBackup)).attachmentCount).toBe(3);

    walWriter.close();
    database.close();
  });

  it("refuses an existing destination and cleans the reserved output after a failed attachment copy", async () => {
    const root = makeTemporaryDirectory();
    const databasePath = join(root, "runtime", "bridge.db");
    mkdirSync(join(root, "runtime"), { recursive: true });
    const database = new StateDatabase(databasePath);
    const roots = defaultBridgeAttachmentRoots(databasePath, root);
    mkdirSync(roots.web[0], { recursive: true });
    const missingPath = join(roots.web[0], "missing.txt");
    database.createStagedWebTaskAttachment({
      attachmentId: "missing-file",
      fileName: "missing.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      localPath: missingPath,
    });
    const existingOutput = join(root, "already-there");
    mkdirSync(existingOutput);
    await expect(createBridgeBackup({ databasePath, outputDirectory: existingOutput, attachmentRoots: roots }))
      .rejects.toThrow(/refusing to overwrite/);
    const failedOutput = join(root, "failed-output");
    await expect(createBridgeBackup({ databasePath, outputDirectory: failedOutput, attachmentRoots: roots }))
      .rejects.toThrow(/missing/);
    expect(existsSync(failedOutput)).toBe(false);
    expect(lstatSync(existingOutput).isDirectory()).toBe(true);
    expect(readdirNames(existingOutput)).toEqual([]);
    database.close();
  });

  it("rejects traversal and symlink artifacts in an untrusted backup", async () => {
    const fixture = await makeSimpleBackup();
    const manifestPath = join(fixture.backupDirectory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { attachments: Array<{ file: string }> };
    manifest.attachments[0].file = "../outside.txt";
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    await expect(verifyBridgeBackup(fixture.backupDirectory)).rejects.toThrow(/escapes|invalid artifact/);

    const second = await makeSimpleBackup();
    const secondManifest = JSON.parse(readFileSync(join(second.backupDirectory, "manifest.json"), "utf8")) as {
      attachments: Array<{ file: string }>;
    };
    const attachmentPath = join(second.backupDirectory, secondManifest.attachments[0].file);
    const outsidePath = join(second.root, "outside.txt");
    writeFileSync(outsidePath, "outside");
    rmSync(attachmentPath);
    symlinkSync(outsidePath, attachmentPath);
    await expect(verifyBridgeBackup(second.backupDirectory)).rejects.toThrow(/symlink/);
  });
});

async function makeSimpleBackup(): Promise<{ root: string; backupDirectory: string }> {
  const root = makeTemporaryDirectory();
  const databasePath = join(root, "runtime", "bridge.db");
  mkdirSync(join(root, "runtime"), { recursive: true });
  const roots = defaultBridgeAttachmentRoots(databasePath, root);
  mkdirSync(roots.web[0], { recursive: true });
  const filePath = join(roots.web[0], "one.txt");
  writeFileSync(filePath, "one");
  const database = new StateDatabase(databasePath);
  database.createStagedWebTaskAttachment({
    attachmentId: "one-file",
    fileName: "one.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
    localPath: filePath,
  });
  database.close();
  const backupDirectory = join(root, "backup");
  await createBridgeBackup({
    databasePath,
    outputDirectory: backupDirectory,
    attachmentRoots: roots,
    programVersion: "test-version",
  });
  return { root, backupDirectory };
}

function makeTemporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "bridge-backup-test-"));
  temporaryDirectories.push(path);
  return path;
}

function readdirNames(path: string): string[] {
  return readdirSync(path);
}
