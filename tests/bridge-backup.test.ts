import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "../src/db.js";
import {
  checkBridgeBackupUpgradeCompatibility,
  createBridgeBackup,
  defaultBridgeAttachmentRoots,
  inspectBridgeBackupMetadata,
  listBridgeBackups,
  restoreBridgeBackup,
  verifyBridgeBackup,
} from "../src/bridge-backup.js";
import { runBackupCli } from "../src/backup-cli.js";
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
    await expect(checkBridgeBackupUpgradeCompatibility(fixture.backupDirectory)).rejects.toThrow("does not match manifest");
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

  it("backs up and relocates Tmux task attachments referenced in durable session actions", async () => {
    const root = makeTemporaryDirectory();
    const databasePath = join(root, "runtime", "bridge.db");
    mkdirSync(join(root, "runtime"), { recursive: true });
    const database = new StateDatabase(databasePath);
    const roots = defaultBridgeAttachmentRoots(databasePath, root);
    const migratedAttachmentRoot = join(root, "home", ".feishu-codex-bridge", "tmux-dashboard-attachments");
    const legacyAttachmentRoot = join(root, "tmp", "feishu-codex-bridge", "tmux-dashboard-attachments");
    roots.tmux = [migratedAttachmentRoot, legacyAttachmentRoot];
    mkdirSync(migratedAttachmentRoot, { recursive: true });
    const imageName = "9c7daf93-0aa0-4e8a-a214-5475796af882.jpg";
    const imagePath = join(migratedAttachmentRoot, imageName);
    const legacyImagePath = join(legacyAttachmentRoot, imageName);
    writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    const session = database.recordTmuxSession({ id: "$1", name: "backup-test", cwd: root, createdAt: 10 });
    const action = database.beginTmuxSessionAction({
      sessionRecordId: session.record_id,
      deviceId: null,
      actionType: "task_submit",
      requestId: "backup-tmux-request",
      content: `请查看我附上的图片：<image name=[Image #1] path="${legacyImagePath}">`,
    });
    expect(action.duplicate).toBe(false);
    database.finishTmuxSessionAction(action.actionId, "confirmed");
    database.close();

    const backupDirectory = join(root, "backup-v2");
    const backup = await createBridgeBackup({ databasePath, outputDirectory: backupDirectory, attachmentRoots: roots });
    expect(backup.attachmentCount).toBe(1);
    const manifest = JSON.parse(readFileSync(join(backupDirectory, "manifest.json"), "utf8")) as {
      formatVersion: number;
      attachments: Array<{ kind: string; file: string; references: Array<{ kind: string; key: string; index?: number }> }>;
    };
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.attachments[0]).toMatchObject({
      kind: "tmux",
      references: [{ kind: "tmux", key: action.actionId, index: 0 }],
    });
    expect((await verifyBridgeBackup(backupDirectory)).attachmentCount).toBe(1);

    const restoreDirectory = join(root, "restored-tmux");
    const restored = await restoreBridgeBackup({ backupDirectory, outputDirectory: restoreDirectory });
    expect(restored.attachmentCount).toBe(1);
    const restoredDatabase = new DatabaseSync(restored.databasePath);
    try {
      const row = restoredDatabase.prepare("SELECT content FROM tmux_session_actions WHERE action_id = ?")
        .get(action.actionId) as { content: string };
      const restoredAttachmentPath = join(restoreDirectory, manifest.attachments[0]!.file);
      expect(row.content).toContain(restoredAttachmentPath);
      expect(existsSync(restoredAttachmentPath)).toBe(true);
    } finally {
      restoredDatabase.close();
    }
  });

  it("refuses an incomplete v1 restore when the database still references Tmux attachments", async () => {
    const root = makeTemporaryDirectory();
    const databasePath = join(root, "runtime", "bridge.db");
    mkdirSync(join(root, "runtime"), { recursive: true });
    const database = new StateDatabase(databasePath);
    const roots = defaultBridgeAttachmentRoots(databasePath, root);
    const tmuxAttachmentRoot = roots.tmux[roots.tmux.length - 1]!;
    mkdirSync(tmuxAttachmentRoot, { recursive: true });
    const imagePath = join(tmuxAttachmentRoot, "9c7daf93-0aa0-4e8a-a214-5475796af882.jpg");
    writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 1]));
    const session = database.recordTmuxSession({ id: "$1", name: "legacy-test", cwd: root, createdAt: 11 });
    const action = database.beginTmuxSessionAction({
      sessionRecordId: session.record_id,
      deviceId: null,
      actionType: "task_submit",
      requestId: "legacy-tmux-request",
      content: `<image name=[Image #1] path="${imagePath}">`,
    });
    database.close();
    const backupDirectory = join(root, "legacy-backup");
    await createBridgeBackup({ databasePath, outputDirectory: backupDirectory, attachmentRoots: roots });

    const manifestPath = join(backupDirectory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { formatVersion: number; attachments: unknown[] };
    manifest.formatVersion = 1;
    manifest.attachments = [];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(join(backupDirectory, "attachments"), { recursive: true, force: true });

    expect((await verifyBridgeBackup(backupDirectory)).attachmentCount).toBe(0);
    const restoreDirectory = join(root, "incomplete-restore");
    await expect(restoreBridgeBackup({ backupDirectory, outputDirectory: restoreDirectory }))
      .rejects.toThrow("旧版备份没有保存 tmux 附件");
    expect(existsSync(restoreDirectory)).toBe(false);
    expect(action.actionId).toBeTruthy();
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

  it("lists and inspects manifest metadata without claiming artifact hash verification", async () => {
    const fixture = await makeSimpleBackup();
    const unrelatedDirectory = join(fixture.root, "unrelated");
    mkdirSync(unrelatedDirectory);
    const invalidDirectory = join(fixture.root, "broken-backup");
    mkdirSync(invalidDirectory);
    writeFileSync(join(invalidDirectory, "manifest.json"), "not json");

    const metadata = await inspectBridgeBackupMetadata(fixture.backupDirectory);
    expect(metadata).toMatchObject({
      programVersion: "test-version",
      attachmentCount: 1,
      attachmentBytes: 3,
      contentHashesVerified: false,
    });
    const entries = await listBridgeBackups(fixture.root);
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.status === "metadata")?.metadata).toMatchObject(metadata);
    expect(entries.find((entry) => entry.status === "invalid")?.error).toContain("JSON");

    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => logged.push(values.join(" "));
    try {
      await runBackupCli(["inspect", "--backup", fixture.backupDirectory]);
      await runBackupCli(["list", "--dir", fixture.root]);
      await runBackupCli(["check-upgrade", "--backup", fixture.backupDirectory]);
    } finally {
      console.log = originalLog;
    }
    expect(JSON.parse(logged[0] ?? "{}")).toMatchObject({ contentHashesVerified: false });
    expect(JSON.parse(logged[1] ?? "[]")).toHaveLength(2);
    expect(JSON.parse(logged[2] ?? "{}")).toMatchObject({ compatible: true });
  });

  it("rejects backup list directories with more than the bounded entry limit", async () => {
    const root = makeTemporaryDirectory();
    for (let index = 0; index <= 1_000; index += 1) mkdirSync(join(root, `entry-${index}`));
    await expect(listBridgeBackups(root)).rejects.toThrow("1000 entry limit");
  });

  it("checks current migration compatibility only on an isolated backup copy", async () => {
    const fixture = await makeSimpleBackup();
    const databasePath = join(fixture.root, "runtime", "bridge.db");
    const oldSchemaDatabase = new DatabaseSync(databasePath);
    oldSchemaDatabase.exec("ALTER TABLE tasks DROP COLUMN worker_pid");
    oldSchemaDatabase.close();
    const oldSchemaBackup = join(fixture.root, "old-schema-backup");
    await createBridgeBackup({
      databasePath,
      outputDirectory: oldSchemaBackup,
      attachmentRoots: defaultBridgeAttachmentRoots(databasePath, fixture.root),
      programVersion: "old-version",
    });
    const backupDatabasePath = join(oldSchemaBackup, "bridge.db");
    const originalBackupDatabase = readFileSync(backupDatabasePath);

    const compatibility = await checkBridgeBackupUpgradeCompatibility(oldSchemaBackup);
    expect(compatibility).toMatchObject({
      sourceProgramVersion: "old-version",
      compatible: true,
      sourceSchemaFingerprint: (await verifyBridgeBackup(oldSchemaBackup)).schemaFingerprint,
    });
    expect(compatibility.sourceSchemaFingerprint).not.toBe(compatibility.migratedSchemaFingerprint);
    expect(readFileSync(backupDatabasePath)).toEqual(originalBackupDatabase);
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
