import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateDatabase } from "../src/db.js";
import { hasNewSubmissionEcho, submissionFingerprint } from "../src/tmux-dashboard-api.js";

const attachmentDirectory = join(tmpdir(), "feishu-codex-bridge", "tmux-dashboard-attachments");
const files: string[] = [];

afterEach(async () => {
  await Promise.all(files.splice(0).map((path) => unlink(path).catch(() => undefined)));
});

describe("tmux submission deduplication", () => {
  it("recognizes a wrapped prompt in scrollback without treating old text as new", () => {
    const prompt = "修改之后，配色很奇怪，请调整。我期望修改的是会话的 Home，并持久化我选择的 Home。";
    const oldScreen = `正在处理旧任务\n${prompt}\n读取文件`;
    expect(hasNewSubmissionEcho(oldScreen, `${oldScreen}\n继续读取文件`, prompt)).toBe(false);
    const newScreen = `${oldScreen}\n> 修改之后，配色很奇怪，请调整。\n我期望修改的是会话的 Home，并持久化我选择的 Home。\nViewed Image`;
    expect(hasNewSubmissionEcho(oldScreen, newScreen, prompt)).toBe(true);
  });

  it("treats separately uploaded copies of the same image as one submission", async () => {
    await mkdir(attachmentDirectory, { recursive: true });
    const firstPath = join(attachmentDirectory, `${randomUUID()}.png`);
    const secondPath = join(attachmentDirectory, `${randomUUID()}.png`);
    const changedPath = join(attachmentDirectory, `${randomUUID()}.png`);
    files.push(firstPath, secondPath, changedPath);
    await Promise.all([
      writeFile(firstPath, "same image"),
      writeFile(secondPath, "same image"),
      writeFile(changedPath, "another image"),
    ]);
    const prompt = (path: string) => `请处理这张图\n<image name=[Image #1] path="${path}">`;
    expect(await submissionFingerprint(prompt(firstPath))).toBe(await submissionFingerprint(prompt(secondPath)));
    expect(await submissionFingerprint(prompt(firstPath))).not.toBe(await submissionFingerprint(prompt(changedPath)));
  });

  it("blocks a recent repeated task after an uncertain result without adding history", () => {
    let clock = new Date("2026-10-04T01:00:00.000Z");
    const db = new StateDatabase(":memory:", () => clock);
    try {
      const firstSession = db.recordTmuxSession({ id: "$1", name: "one", cwd: "/tmp", createdAt: 1 });
      const secondSession = db.recordTmuxSession({ id: "$2", name: "two", cwd: "/tmp", createdAt: 2 });
      const submit = (sessionRecordId: string, fingerprint = "same") => db.beginTmuxSessionAction({
        sessionRecordId,
        deviceId: null,
        actionType: "task_submit",
        requestId: randomUUID(),
        content: "处理图片",
        submissionFingerprint: fingerprint,
      });
      const first = submit(firstSession.record_id);
      expect(first.duplicate).toBe(false);
      expect(submit(firstSession.record_id).duplicate).toBe(true);
      db.finishTmuxSessionAction(first.actionId, "unconfirmed");
      expect(submit(firstSession.record_id).duplicate).toBe(true);
      expect(submit(firstSession.record_id, "different").duplicate).toBe(false);
      expect(submit(secondSession.record_id).duplicate).toBe(false);
      expect(db.listTmuxSessionActions().total).toBe(3);

      clock = new Date("2026-10-04T01:06:00.000Z");
      expect(submit(firstSession.record_id).duplicate).toBe(false);
    } finally {
      db.close();
    }
  });

  it("projects timed-out sending actions as delivery-unknown without changing stored status", () => {
    let clock = new Date("2026-10-04T01:00:00.000Z");
    const root = mkdtempSync(join(tmpdir(), "bridge-tmux-restart-test-"));
    const databasePath = join(root, "bridge.db");
    let db = new StateDatabase(databasePath, () => clock);
    try {
      const session = db.recordTmuxSession({ id: "$1", name: "restart-test", cwd: "/tmp", createdAt: 1 });
      const timedOut = db.beginTmuxSessionAction({
        sessionRecordId: session.record_id,
        deviceId: null,
        actionType: "task_submit",
        requestId: "timed-out-submit",
        content: "处理等待超时的任务",
        submissionFingerprint: "timed-out-fingerprint",
      });
      clock = new Date("2026-10-04T01:00:05.000Z");
      const recent = db.beginTmuxSessionAction({
        sessionRecordId: session.record_id,
        deviceId: null,
        actionType: "task_submit",
        requestId: "recent-submit",
        content: "刚提交的任务",
        submissionFingerprint: "recent-fingerprint",
      });
      expect(timedOut.duplicate).toBe(false);
      expect(recent.duplicate).toBe(false);
      db.close();

      clock = new Date("2026-10-04T01:00:10.000Z");
      db = new StateDatabase(databasePath, () => clock);
      const actions = db.listTmuxSessionActions().items;
      expect(actions.find((action) => action.action_id === timedOut.actionId)).toMatchObject({
        status: "unconfirmed",
        error: "发送确认已超过 10 秒等待窗口；消息可能已写入 Session。请先查看 Session，再决定是否重新提交。",
      });
      expect(actions.find((action) => action.action_id === recent.actionId)?.status).toBe("sending");

      const duplicate = db.beginTmuxSessionAction({
        sessionRecordId: session.record_id,
        deviceId: null,
        actionType: "task_submit",
        requestId: "retry-timed-out-submit",
        content: "处理等待超时的任务",
        submissionFingerprint: "timed-out-fingerprint",
      });
      expect(duplicate).toEqual({ actionId: "", duplicate: true });

      clock = new Date("2026-10-04T01:00:09.999Z");
      expect(db.listTmuxSessionActions().items.find((action) => action.action_id === timedOut.actionId)?.status).toBe("sending");
      expect(db.finishTmuxSessionAction(timedOut.actionId, "confirmed")).toBe(true);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
