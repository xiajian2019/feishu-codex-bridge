import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "../src/db.js";
import {
  checkBridgeBackupUpgradeCompatibility,
  createBridgeBackup,
  inspectBridgeBackupMetadata,
  listBridgeBackups,
  restoreBridgeBackup,
  verifyBridgeBackup,
} from "../src/bridge-backup.js";
import { runBackupCli } from "../src/backup-cli.js";
import { DatabaseSync } from "../src/sqlite.js";
import type { RoutedTask } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Bridge backup", () => {
  it("preserves managed task workspace metadata when restoring the Bridge database", async () => {
    const root = makeTemporaryDirectory();
    const databasePath = join(root, "runtime", "bridge.db");
    mkdirSync(join(root, "runtime"), { recursive: true });
    const database = new StateDatabase(databasePath);
    const routedTask: RoutedTask = {
      taskGuid: "web-worktree-backup",
      summary: "Backup worktree metadata",
      description: "Verify persisted workspace links",
      projectKey: "fixture",
      mode: "implement",
      repo: join(root, "project"),
      sandboxMode: "workspace-write",
      inputHash: "input-hash",
      input: { projectKey: "fixture", mode: "implement", summary: "Backup worktree metadata", description: "Verify persisted workspace links" },
      completed: false,
      origin: "web",
    };
    const workspace = {
      workspaceId: "workspace-backup",
      taskGuid: routedTask.taskGuid,
      projectKey: "fixture",
      projectRoot: routedTask.repo,
      projectGitRoot: routedTask.repo,
      gitCommonDirectory: join(routedTask.repo, ".git"),
      workingDirectory: join(root, "worktrees", "fixture", "task"),
      worktreePath: join(root, "worktrees", "fixture", "task"),
      branch: "bridge/tasks/backup-worktree-metadata",
      baseRef: "main",
      baseSha: "a".repeat(40),
      sourceTmuxSessionId: "$8",
    };
    database.claimWebTaskSubmission({
      idempotencyKey: "backup-worktree-submit",
      normalizedRequestJson: "{}",
      task: routedTask,
      inputText: JSON.stringify(routedTask.input),
      promptText: "backup fixture",
      workspace,
    });

    const backupDirectory = join(root, "backup-worktree-metadata");
    await createBridgeBackup({
      databasePath,
      outputDirectory: backupDirectory,
      programVersion: "test-workspace-version",
    });
    const restored = await restoreBridgeBackup({ backupDirectory, outputDirectory: join(root, "restored-worktree-metadata") });
    const restoredDatabase = new StateDatabase(restored.databasePath);
    try {
      expect(restoredDatabase.getTaskWorkspace(routedTask.taskGuid)).toMatchObject({
        workspace_id: workspace.workspaceId,
        task_guid: routedTask.taskGuid,
        worktree_path: workspace.worktreePath,
        branch: workspace.branch,
        base_sha: workspace.baseSha,
        source_tmux_session_id: "$8",
        status: "provisioning",
      });
    } finally {
      restoredDatabase.close();
      database.close();
    }
  });

  it("rejects a modified SQLite file before creating any restored output", async () => {
    const fixture = await makeSimpleBackup();
    writeFileSync(join(fixture.backupDirectory, "bridge.db"), "modified database");
    await expect(verifyBridgeBackup(fixture.backupDirectory)).rejects.toThrow("database hash or size");
    await expect(checkBridgeBackupUpgradeCompatibility(fixture.backupDirectory)).rejects.toThrow("database hash or size");
    const outputDirectory = join(fixture.root, "restore-tampered");
    await expect(restoreBridgeBackup({ backupDirectory: fixture.backupDirectory, outputDirectory })).rejects.toThrow("database hash or size");
    expect(existsSync(outputDirectory)).toBe(false);
  });

  it("snapshots an open WAL database without copying files or rewriting attachment records", async () => {
    const root = makeTemporaryDirectory();
    const databaseDirectory = join(root, "data");
    mkdirSync(databaseDirectory, { recursive: true });
    const realDatabasePath = join(databaseDirectory, "bridge-data.db");
    const databasePath = join(databaseDirectory, "bridge.db");
    symlinkSync(realDatabasePath, databasePath);
    const webPath = join(root, "web.txt");
    const directPath = join(root, "missing-direct.png");
    const aampPath = join(root, "symlink-aamp.png");
    writeFileSync(webPath, "web attachment\n");
    symlinkSync(webPath, aampPath);
    writeFileSync(join(root, "config.json"), "unrelated configuration");
    const database = new StateDatabase(databasePath);
    const walWriter = new DatabaseSync(databasePath);
    try {
      database.createStagedWebTaskAttachment({
        attachmentId: "web-attachment-1", fileName: "web.txt", mimeType: "text/plain",
        sizeBytes: Buffer.byteLength("web attachment\n"), localPath: webPath,
      });
      const directTask = database.ingestDirectMessage({
        sourceEventId: "evt-backup", eventType: "im.message.receive_v1", messageId: "msg-backup",
        chatId: "chat-backup", chatType: "p2p", senderId: "sender-backup", text: "请处理图片", sessionKey: "chat:backup",
        attachments: [{ type: "image", fileKey: "file-key", fileName: "direct.png" }],
      }).task;
      const directAttachment = database.getBridgeTaskAttachments(directTask.bridge_task_id)[0]!;
      database.markAttachmentDownloaded(directAttachment.attachment_id, directPath);
      database.initializeAampTask({ aampTaskId: "aamp-backup", chatId: "chat-aamp", imageLocalPaths: [aampPath] });
      const action = addTmuxAttachmentReference(database, root);
      walWriter.exec("CREATE TABLE wal_snapshot_probe (request_key TEXT PRIMARY KEY, result TEXT NOT NULL)");
      walWriter.prepare("INSERT INTO wal_snapshot_probe VALUES (?, ?)").run("key-1", "saved-in-wal");
      expect(existsSync(`${realDatabasePath}-wal`)).toBe(true);

      const backupDirectory = join(root, "backup");
      const backup = await createBridgeBackup({ databasePath, outputDirectory: backupDirectory, programVersion: "test-version" });
      expect(backup).toMatchObject({ scope: "sqlite", attachmentCount: 0, attachmentBytes: 0 });
      expect(readdirSync(backupDirectory).sort()).toEqual(["bridge.db", "manifest.json"]);
      expect(JSON.parse(readFileSync(join(backupDirectory, "manifest.json"), "utf8")))
        .toMatchObject({ formatVersion: 3, scope: "sqlite", attachments: [] });
      expect(lstatSync(databasePath).isSymbolicLink()).toBe(true);
      expect(lstatSync(backupDirectory).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(backupDirectory, "bridge.db")).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(backupDirectory, "manifest.json")).mode & 0o777).toBe(0o600);
      expect(database.getStagedWebTaskAttachment("web-attachment-1")?.local_path).toBe(webPath);

      const verification = await verifyBridgeBackup(backupDirectory);
      expect(verification).toMatchObject({ scope: "sqlite", formatVersion: 3, programVersion: "test-version",
        attachmentCount: 0, schemaFingerprint: backup.schemaFingerprint });
      const restoreDirectory = join(root, "restored");
      const restored = await restoreBridgeBackup({ backupDirectory, outputDirectory: restoreDirectory });
      expect(restored).toMatchObject({ scope: "sqlite", attachmentCount: 0, attachmentBytes: 0 });
      expect(readdirSync(restoreDirectory)).toEqual(["bridge.db"]);
      expect(readFileSync(restored.databasePath)).toEqual(readFileSync(join(backupDirectory, "bridge.db")));
      const restoredDatabase = new StateDatabase(restored.databasePath);
      const restoredProbe = new DatabaseSync(restored.databasePath);
      try {
        expect(restoredProbe.prepare("SELECT result FROM wal_snapshot_probe WHERE request_key = ?").get("key-1"))
          .toEqual({ result: "saved-in-wal" });
        expect(restoredDatabase.getStagedWebTaskAttachment("web-attachment-1")?.local_path).toBe(webPath);
        expect(restoredDatabase.getBridgeTaskAttachments(directTask.bridge_task_id)[0]?.local_path).toBe(directPath);
        expect(restoredDatabase.listAampTasks({ search: "aamp-backup" }).items[0]?.image_local_paths).toEqual([aampPath]);
        expect(restoredProbe.prepare("SELECT content FROM tmux_session_actions WHERE action_id = ?").get(action.actionId))
          .toEqual({ content: action.content });
        expect(restoredProbe.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        restoredProbe.close();
        restoredDatabase.close();
      }
      const secondBackup = join(root, "rebackup");
      await createBridgeBackup({ databasePath: restored.databasePath, outputDirectory: secondBackup });
      expect((await verifyBridgeBackup(secondBackup)).attachmentCount).toBe(0);
      expect(readdirSync(secondBackup).sort()).toEqual(["bridge.db", "manifest.json"]);
      expect(walWriter.prepare("SELECT result FROM wal_snapshot_probe WHERE request_key = ?").get("key-1"))
        .toEqual({ result: "saved-in-wal" });
    } finally {
      walWriter.close();
      database.close();
    }
  });

  for (const formatVersion of [1, 2]) {
    it.each(["missing", "modified", "symlink"])(`restores only SQLite from v${formatVersion} with %s legacy attachments`, async (state) => {
      const fixture = await makeSimpleBackup();
      const databasePath = join(fixture.root, "runtime", "bridge.db");
      const database = new StateDatabase(databasePath);
      const action = addTmuxAttachmentReference(database, fixture.root);
      database.close();
      const backupDirectory = join(fixture.root, `legacy-${formatVersion}`);
      await createBridgeBackup({ databasePath, outputDirectory: backupDirectory });
      const manifestPath = join(backupDirectory, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.formatVersion = formatVersion;
      delete manifest.scope;
      const attachmentFile = "attachments/web/9c7daf93-0aa0-4e8a-a214-5475796af882.txt";
      manifest.attachments = [{
        id: "9c7daf93-0aa0-4e8a-a214-5475796af882", kind: "web", file: attachmentFile,
        sha256: "0".repeat(64), bytes: 3, references: [{ kind: "web", key: "one-file" }],
      }];
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      if (state === "modified") {
        mkdirSync(join(backupDirectory, "attachments", "web"), { recursive: true });
        writeFileSync(join(backupDirectory, attachmentFile), "modified legacy attachment");
      } else if (state === "symlink") {
        symlinkSync(join(fixture.root, "nonexistent-attachments"), join(backupDirectory, "attachments"));
      }
      const originalManifest = readFileSync(manifestPath);
      const originalDatabase = readFileSync(join(backupDirectory, "bridge.db"));
      expect(await verifyBridgeBackup(backupDirectory)).toMatchObject({ scope: "sqlite", formatVersion, attachmentCount: 0 });
      expect((await checkBridgeBackupUpgradeCompatibility(backupDirectory)).compatible).toBe(true);
      const restoreDirectory = join(fixture.root, `restore-v${formatVersion}`);
      const restored = await restoreBridgeBackup({ backupDirectory, outputDirectory: restoreDirectory });
      expect(readdirSync(restoreDirectory)).toEqual(["bridge.db"]);
      expect(readFileSync(restored.databasePath)).toEqual(originalDatabase);
      const restoredDatabase = new DatabaseSync(restored.databasePath);
      try {
        expect(restoredDatabase.prepare("SELECT content FROM tmux_session_actions WHERE action_id = ?").get(action.actionId))
          .toEqual({ content: action.content });
        expect(restoredDatabase.prepare("SELECT local_path FROM web_task_attachments WHERE attachment_id = 'one-file'").get())
          .toEqual({ local_path: join(fixture.root, "missing-attachment.txt") });
      } finally { restoredDatabase.close(); }
      expect(readFileSync(manifestPath)).toEqual(originalManifest);
      expect(readFileSync(join(backupDirectory, "bridge.db"))).toEqual(originalDatabase);
    });
  }

  it("refuses existing backup and restore destinations without overwriting their contents", async () => {
    const fixture = await makeSimpleBackup();
    const existingOutput = join(fixture.root, "already-there");
    mkdirSync(existingOutput);
    writeFileSync(join(existingOutput, "keep.txt"), "preserved");
    await expect(createBridgeBackup({ databasePath: join(fixture.root, "runtime", "bridge.db"), outputDirectory: existingOutput }))
      .rejects.toThrow(/refusing to overwrite/);
    await expect(restoreBridgeBackup({ backupDirectory: fixture.backupDirectory, outputDirectory: existingOutput }))
      .rejects.toThrow(/refusing to overwrite/);
    expect(readdirSync(existingOutput)).toEqual(["keep.txt"]);
    expect(readFileSync(join(existingOutput, "keep.txt"), "utf8")).toBe("preserved");
  });

  it("removes staged output when the source is not a Bridge database", async () => {
    const root = makeTemporaryDirectory();
    const databasePath = join(root, "unrelated.db");
    const unrelated = new DatabaseSync(databasePath);
    unrelated.exec("CREATE TABLE unrelated (value TEXT)");
    unrelated.close();
    const outputDirectory = join(root, "failed-output");
    await expect(createBridgeBackup({ databasePath, outputDirectory })).rejects.toThrow("not a Bridge database");
    expect(existsSync(outputDirectory)).toBe(false);
    expect(readdirSync(root).filter((name) => name.includes("bridge-stage"))).toEqual([]);
  });

  it("rejects traversal in the SQLite artifact path", async () => {
    const fixture = await makeSimpleBackup();
    const manifestPath = join(fixture.backupDirectory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.database.file = "../outside.db";
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    await expect(verifyBridgeBackup(fixture.backupDirectory)).rejects.toThrow("database record is invalid");
  });

  it.each(["bridge.db", "manifest.json"])("rejects a symlink for %s in an untrusted backup", async (file) => {
    const fixture = await makeSimpleBackup();
    const artifactPath = join(fixture.backupDirectory, file);
    const outsidePath = join(fixture.root, file);
    writeFileSync(outsidePath, readFileSync(artifactPath));
    rmSync(artifactPath);
    symlinkSync(outsidePath, artifactPath);
    await expect(verifyBridgeBackup(fixture.backupDirectory)).rejects.toThrow("symlink");
  });

  it("rejects non-SQLite artifacts and attachment declarations in new backups", async () => {
    const fixture = await makeSimpleBackup();
    writeFileSync(join(fixture.backupDirectory, "config.json"), "{}");
    await expect(verifyBridgeBackup(fixture.backupDirectory)).rejects.toThrow("unexpected artifact");
    rmSync(join(fixture.backupDirectory, "config.json"));
    const manifestPath = join(fixture.backupDirectory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.attachments = [{ file: "../outside.txt" }];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(verifyBridgeBackup(fixture.backupDirectory)).rejects.toThrow("no attachments");
  });

  it("lists and inspects manifest metadata without claiming SQLite hash verification", async () => {
    const fixture = await makeSimpleBackup();
    mkdirSync(join(fixture.root, "unrelated"));
    const invalidDirectory = join(fixture.root, "broken-backup");
    mkdirSync(invalidDirectory);
    writeFileSync(join(invalidDirectory, "manifest.json"), "not json");
    const metadata = await inspectBridgeBackupMetadata(fixture.backupDirectory);
    expect(metadata).toMatchObject({ scope: "sqlite", programVersion: "test-version", attachmentCount: 0,
      attachmentBytes: 0, contentHashesVerified: false });
    const entries = await listBridgeBackups(fixture.root);
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.status === "metadata")?.metadata).toMatchObject(metadata);
    expect(entries.find((entry) => entry.status === "invalid")?.error).toContain("JSON");
    const logged = await captureCliOutput(async () => {
      await runBackupCli(["inspect", "--backup", fixture.backupDirectory]);
      await runBackupCli(["list", "--dir", fixture.root]);
      await runBackupCli(["check-upgrade", "--backup", fixture.backupDirectory]);
    });
    expect(JSON.parse(logged[0] ?? "{}")).toMatchObject({ scope: "sqlite", contentHashesVerified: false });
    expect(JSON.parse(logged[1] ?? "[]")).toHaveLength(2);
    expect(JSON.parse(logged[2] ?? "{}")).toMatchObject({ compatible: true });
    writeFileSync(join(fixture.backupDirectory, "bridge.db"), "tampered");
    expect(await inspectBridgeBackupMetadata(fixture.backupDirectory)).toEqual(metadata);
    await expect(verifyBridgeBackup(fixture.backupDirectory)).rejects.toThrow("database hash or size");
  });

  it("creates and restores SQLite via CLI while ignoring obsolete attachment-root flags", async () => {
    const fixture = await makeSimpleBackup();
    const backupDirectory = join(fixture.root, "cli-backup");
    const outputDirectory = join(fixture.root, "cli-restore");
    const logged = await captureCliOutput(async () => {
      await runBackupCli(["create", "--db", join(fixture.root, "runtime", "bridge.db"), "--out", backupDirectory,
        "--data-root", "/unused-install", "--web-root", "/unused-web", "--direct-root", "/unused-direct", "--aamp-root", "/unused-aamp"]);
      await runBackupCli(["verify", "--backup", backupDirectory]);
      await runBackupCli(["restore", "--backup", backupDirectory, "--out", outputDirectory]);
    });
    for (const result of logged) expect(JSON.parse(result)).toMatchObject({ scope: "sqlite", attachmentCount: 0 });
    expect(readdirSync(backupDirectory).sort()).toEqual(["bridge.db", "manifest.json"]);
    expect(readdirSync(outputDirectory)).toEqual(["bridge.db"]);
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
    await createBridgeBackup({ databasePath, outputDirectory: oldSchemaBackup, programVersion: "old-version" });
    const backupDatabasePath = join(oldSchemaBackup, "bridge.db");
    const originalBackupDatabase = readFileSync(backupDatabasePath);
    const compatibility = await checkBridgeBackupUpgradeCompatibility(oldSchemaBackup);
    expect(compatibility).toMatchObject({ sourceProgramVersion: "old-version", compatible: true,
      sourceSchemaFingerprint: (await verifyBridgeBackup(oldSchemaBackup)).schemaFingerprint });
    expect(compatibility.sourceSchemaFingerprint).not.toBe(compatibility.migratedSchemaFingerprint);
    expect(readFileSync(backupDatabasePath)).toEqual(originalBackupDatabase);
  });
});

async function makeSimpleBackup(): Promise<{ root: string; backupDirectory: string }> {
  const root = makeTemporaryDirectory();
  const databasePath = join(root, "runtime", "bridge.db");
  mkdirSync(join(root, "runtime"), { recursive: true });
  const database = new StateDatabase(databasePath);
  database.createStagedWebTaskAttachment({ attachmentId: "one-file", fileName: "one.txt", mimeType: "text/plain",
    sizeBytes: 3, localPath: join(root, "missing-attachment.txt") });
  database.close();
  const backupDirectory = join(root, "backup");
  await createBridgeBackup({ databasePath, outputDirectory: backupDirectory, programVersion: "test-version" });
  return { root, backupDirectory };
}

function addTmuxAttachmentReference(database: StateDatabase, root: string): { actionId: string; content: string } {
  const session = database.recordTmuxSession({ id: "$1", name: "backup-test", cwd: root, createdAt: 10 });
  const imagePath = join(root, ".feishu-codex-bridge", "tmux-dashboard-attachments", "9c7daf93-0aa0-4e8a-a214-5475796af882.jpg");
  const content = `请查看图片：<image name=[Image #1] path="${imagePath}">`;
  const action = database.beginTmuxSessionAction({ sessionRecordId: session.record_id, deviceId: null,
    actionType: "task_submit", requestId: "backup-tmux-request", content });
  database.finishTmuxSessionAction(action.actionId, "confirmed");
  return { actionId: action.actionId, content };
}

async function captureCliOutput(action: () => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => logged.push(values.join(" "));
  try { await action(); } finally { console.log = originalLog; }
  return logged;
}

function makeTemporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "bridge-backup-test-"));
  temporaryDirectories.push(path);
  return path;
}
